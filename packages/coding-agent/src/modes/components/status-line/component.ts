import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { type Component, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import * as git from "../../../utils/git";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import { theme } from "../../theme/theme";
import { computeNonMessageTokens } from "../../utils/context-usage";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { getPreset } from "./presets";
import { renderSegment, type SegmentContext } from "./segments";
import { getSeparator } from "./separators";
import { calculateTokensPerSecond } from "./token-rate";
import type {
	CollabStatus,
	EffectiveStatusLineSettings,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Per-message token cache
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Symbol-keyed sidecar tagged onto each `AgentMessage` to memoize its
 * `estimateTokens` result. Keyed by message identity (the object itself);
 * a cheap content fingerprint detects in-place mutations (post-hoc error
 * attachment, retry-truncated branch rebuild, etc.) and forces recompute.
 *
 * Cache lives on the message — multiple `StatusLineComponent` instances
 * share it for free, and entries collect with the message itself when the
 * conversation is replaced or compacted.
 */
const kTokenCache = Symbol("statusLine.tokenCache");
interface TaggedMessage {
	[kTokenCache]?: { fingerprint: string; tokens: number };
}

/**
 * Cheap structural fingerprint mirroring `estimateTokens`'s content walk.
 * O(blocks) — only reads string `.length` and primitives, never copies or
 * serializes content. Any in-place mutation that alters total tokenized
 * content also alters one of the byte-length sums or block counts captured
 * here, forcing the cached `estimateTokens` value to be recomputed.
 */
function messageFingerprint(msg: AgentMessage): string {
	const role = (msg as { role?: string }).role ?? "";
	const ts = (msg as { timestamp?: number }).timestamp ?? 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (role === "bashExecution") {
		const b = msg as { command?: unknown; output?: unknown };
		if (typeof b.command === "string") textLen += b.command.length;
		if (typeof b.output === "string") textLen += b.output.length;
	} else if (role === "user") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") textLen += block.text.length;
			}
		}
	} else if (role === "assistant") {
		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "thinking" && typeof b.thinking === "string") textLen += b.thinking.length;
				else if (b.type === "toolCall") {
					if (typeof b.name === "string") textLen += b.name.length;
					// Argument bytes vary; a length proxy is enough to detect in-place edits.
					textLen += b.arguments === undefined ? 0 : JSON.stringify(b.arguments).length;
				}
			}
		}
	} else if (role === "toolResult" || role === "hookMessage") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "image") images++;
			}
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		const s = (msg as { summary?: unknown }).summary;
		if (typeof s === "string") textLen += s.length;
	}
	return `${role}:${ts}:${textLen}:${blocks}:${images}`;
}

/**
 * Token count for a single message, using the per-message sidecar cache.
 * The caller MUST skip caching for the last message during streaming —
 * it may still be growing and its tokens belong recomputed each refresh.
 */
function tokensForMessage(msg: AgentMessage): number {
	const fp = messageFingerprint(msg);
	const tagged = msg as TaggedMessage;
	const cached = tagged[kTokenCache];
	if (cached && cached.fingerprint === fp) return cached.tokens;
	const tokens = estimateTokens(msg);
	tagged[kTokenCache] = { fingerprint: fp, tokens };
	return tokens;
}

interface MessageTokenTotalsCache {
	messagesRef: readonly AgentMessage[];
	stableCount: number;
	stableTokens: number;
	lastStableMessage: AgentMessage | undefined;
	lastStableFingerprint: string | undefined;
}

function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	#sessionStartTime: number = Date.now();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;

	// Git status caching (1s TTL)
	#cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#gitStatusLastFetch = 0;
	#gitStatusInFlight = false;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;

	// Anthropic usage caching (5-min TTL, OAuth/sub only)
	#cachedUsage: {
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	// Context breakdown — incremental rolling cache. The status line refreshes
	// on every agent event, so the hot path must not re-tokenize the full
	// message list. Stable messages are accumulated once; normal streaming
	// refreshes only recompute the current tail message and newly appended
	// entries. History rewrites/compaction replace or shrink the message array
	// and rebuild this cache. Stable messages are treated as immutable after
	// promotion, matching the normal append-only session flow.
	// Cached non-message total (system prompt + tools + skills). Invalidated
	// when the inputs-identity fingerprint changes (model swap, skill toggle,
	// tool registration).
	#nonMessageTokensCache: number | undefined;
	#nonMessageInputsKey: string | undefined;
	#messageTokenTotalsCache: MessageTokenTotalsCache | undefined;

	constructor(private session: AgentSession) {
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
		};
	}

	/**
	 * Re-point the status line at another session (focus proxy). Invalidate: model/context/usage all derive
	 * from it. `focusedAgentId` is the focused subagent id while the view is proxied, undefined for main.
	 */
	setSession(session: AgentSession, focusedAgentId?: string): void {
		const sessionChanged = this.session !== session;
		if (!sessionChanged && this.#focusedAgentId === focusedAgentId) return;
		this.session = session;
		this.#focusedAgentId = focusedAgentId;
		if (sessionChanged) this.#invalidateSessionCaches();
		this.invalidate();
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = settings;
		this.#effectiveSettings = undefined;
	}

	getEffectiveSettingsForTest(): EffectiveStatusLineSettings {
		return this.#resolveSettings();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = count;
	}

	/** Active subagent count as currently displayed (collab state mirroring). */
	get subagentCount(): number {
		return this.#subagentCount;
	}

	setSessionStartTime(time: number): void {
		this.#sessionStartTime = time;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: { enabled: boolean } | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setCollabStatus(status: CollabStatus | null): void {
		this.#collabStatus = status;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		const repository = git.repo.resolveSync(getProjectDir());
		if (!repository) return;

		const watchPath = git.repo.isReftableSync(repository)
			? path.join(repository.gitDir, "reftable")
			: repository.headPath;

		try {
			this.#gitWatcher = fs.watch(watchPath, () => {
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	invalidate(): void {
		this.#invalidateGitCaches();
	}
	#invalidateSessionCaches(): void {
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		this.#usageInFlight = false;
		this.#nonMessageTokensCache = undefined;
		this.#nonMessageInputsKey = undefined;
		this.#messageTokenTotalsCache = undefined;
		this.#lastTokensPerSecond = null;
		this.#lastTokensPerSecondTimestamp = null;
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedPrContext = undefined;
	}
	#getCurrentBranch(): string | null {
		const cwd = getProjectDir();
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === cwd) {
			return this.#cachedBranch;
		}

		const head = git.head.resolveSync(cwd);
		const gitHeadPath = head?.headPath ?? null;
		this.#cachedBranchCwd = cwd;
		this.#cachedBranchRepoId = gitHeadPath;
		if (!head) {
			this.#cachedBranch = null;
			return null;
		}

		this.#cachedBranch = head.kind === "ref" ? (head.branchName ?? head.ref) : "detached";

		return this.#cachedBranch ?? null;
	}

	#isDefaultBranch(branch: string): boolean {
		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			(async () => {
				const resolved = await git.branch.default(getProjectDir());
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		if (this.#gitStatusInFlight || Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlight = true;

		(async () => {
			try {
				this.#cachedGitStatus = await git.status.summary(getProjectDir());
			} catch {
				this.#cachedGitStatus = null;
			} finally {
				this.#gitStatusLastFetch = Date.now();
				this.#gitStatusInFlight = false;
			}
		})();

		return this.#cachedGitStatus;
	}

	#lookupPr(): { number: number; url: string } | null {
		const branch = this.#getCurrentBranch();
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		// Don't look up if no branch, detached HEAD, default branch, or already in flight
		if (!branch || branch === "detached" || this.#isDefaultBranch(branch) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch();
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Requires `gh repo set-default` to be configured; fails gracefully if not
				const result = await $`gh pr view --json number,url`.quiet().nothrow();
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout.toString()) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	/**
	 * Background-refresh the Anthropic OAuth quota report. Guarded by a 5-min
	 * TTL on both success (cache lifetime) and error (backoff). Exposed
	 * (non-private) so unit tests can verify the backoff invariant.
	 */
	refreshUsageInBackground(): void {
		const now = Date.now();
		if (this.#usageInFlight) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		const session = this.session;
		const fetcher = (session as { fetchUsageReports?: () => Promise<unknown> }).fetchUsageReports;
		if (typeof fetcher !== "function") return;
		this.#usageInFlight = true;
		void fetcher
			.call(session)
			.then(reports => {
				if (this.session !== session) return;
				this.#cachedUsage = this.#normalizeUsageReports(reports);
				this.#usageFetchedAt = Date.now();
			})
			.catch(() => {
				if (this.session !== session) return;
				// Backoff on error: stamp the fetch time so the 5-min TTL guard
				// also acts as an error budget. Without this, every render
				// kicks off another fetch (gated only by #usageInFlight),
				// which hammers the endpoint during a network outage / 5xx.
				this.#usageFetchedAt = Date.now();
			})
			.finally(() => {
				if (this.session === session) this.#usageInFlight = false;
			});
	}

	#normalizeUsageReports(reports: unknown): {
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null {
		if (!Array.isArray(reports)) return null;
		let fiveHour: { percent: number; resetMinutes?: number } | undefined;
		let sevenDay: { percent: number; resetHours?: number } | undefined;
		const now = Date.now();
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				const l = limit as {
					scope?: { windowId?: string; tier?: string };
					window?: { resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const windowId = l.scope?.windowId;
				const tier = l.scope?.tier;
				const resetsAt = l.window?.resetsAt;
				if (windowId === "5h" && !tier && !fiveHour) {
					fiveHour = {
						percent: fraction * 100,
						resetMinutes:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 60_000)) : undefined,
					};
				} else if (windowId === "7d" && !tier && !sevenDay) {
					sevenDay = {
						percent: fraction * 100,
						resetHours:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 3_600_000)) : undefined,
					};
				}
			}
		}
		if (!fiveHour && !sevenDay) return null;
		return { fiveHour, sevenDay };
	}

	/**
	 * Compute the (cached) used-tokens / context-window totals for the
	 * status-line context% segment. Exposed (non-private) so unit tests can
	 * verify the incremental-cache invariants; not part of any external
	 * API.
	 */
	getCachedContextBreakdown(): { usedTokens: number; contextWindow: number } {
		const messages = this.session.messages ?? [];
		const contextWindow = this.session.model?.contextWindow ?? 0;

		// 1) Non-message tokens (system prompt + tools + skills). Refresh only
		//    when the inputs identity fingerprint changes — usually never
		//    during a streaming turn. ~10-30 ms when it does refresh.
		const inputsKey = this.#computeNonMessageInputsKey();
		if (this.#nonMessageTokensCache === undefined || this.#nonMessageInputsKey !== inputsKey) {
			this.#nonMessageTokensCache = computeNonMessageTokens(this.session);
			this.#nonMessageInputsKey = inputsKey;
		}

		// 2) Message tokens — incremental rolling total. The sidecar cache lives
		//    on each stable message object (all but the current tail). Normal
		//    streaming turns only recompute the last message and newly appended
		//    entries. Full rebuild only when the message array is replaced,
		//    shrinks, or the recently-promoted stable tail mutates in place.
		const messagesTokens = this.#getCachedMessageTokens(messages);

		const usedTokens = this.#nonMessageTokensCache + messagesTokens;
		return { usedTokens, contextWindow };
	}

	#getCachedMessageTokens(messages: readonly AgentMessage[]): number {
		const cache = this.#messageTokenTotalsCache;
		if (!cache || cache.messagesRef !== messages || messages.length <= cache.stableCount) {
			return this.#rebuildMessageTokenTotals(messages);
		}

		let stableTokens = cache.stableTokens;
		let stableCount = cache.stableCount;
		const stableLimit = Math.max(0, messages.length - 1);

		if (
			cache.lastStableMessage &&
			stableCount > 0 &&
			messages[stableCount - 1] === cache.lastStableMessage &&
			cache.lastStableFingerprint !== undefined &&
			cache.lastStableFingerprint !== messageFingerprint(cache.lastStableMessage)
		) {
			return this.#rebuildMessageTokenTotals(messages);
		}

		while (stableCount < stableLimit) {
			const promoted = messages[stableCount]!;
			stableTokens += tokensForMessage(promoted);
			stableCount++;
		}

		const lastStableMessage = stableCount > 0 ? messages[stableCount - 1] : undefined;
		const lastStableFingerprint = lastStableMessage ? messageFingerprint(lastStableMessage) : undefined;
		const lastMessage = messages.at(-1);
		const lastTokens = lastMessage ? estimateTokens(lastMessage) : 0;
		this.#messageTokenTotalsCache = {
			messagesRef: messages,
			stableCount,
			stableTokens,
			lastStableMessage,
			lastStableFingerprint,
		};
		return stableTokens + lastTokens;
	}

	#rebuildMessageTokenTotals(messages: readonly AgentMessage[]): number {
		let stableTokens = 0;
		const stableLimit = Math.max(0, messages.length - 1);
		for (let i = 0; i < stableLimit; i++) {
			stableTokens += tokensForMessage(messages[i]!);
		}

		const lastStableMessage = stableLimit > 0 ? messages[stableLimit - 1] : undefined;
		const lastStableFingerprint = lastStableMessage ? messageFingerprint(lastStableMessage) : undefined;
		const lastMessage = messages.at(-1);
		const lastTokens = lastMessage ? estimateTokens(lastMessage) : 0;

		this.#messageTokenTotalsCache = {
			messagesRef: messages,
			stableCount: stableLimit,
			stableTokens,
			lastStableMessage,
			lastStableFingerprint,
		};
		return stableTokens + lastTokens;
	}

	/**
	 * Build an identity fingerprint for the non-message inputs (system prompt,
	 * tools, skills). When this changes, the non-message token cache must be
	 * recomputed. Cheap: just lengths + first-string-length. Doesn't need to
	 * be cryptographically unique — only stable for the same inputs.
	 */
	#computeNonMessageInputsKey(): string {
		const sp = this.session.systemPrompt ?? [];
		const tools = this.session.agent?.state?.tools ?? [];
		const skills = this.session.skills ?? [];
		const modelId = this.session.model?.id ?? "";
		return `${modelId}|${sp.length}:${sp[0]?.length ?? 0}|${tools.length}|${skills.length}`;
	}

	#buildSegmentContext(
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includeContext: boolean,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		let contextTokens = 0;
		let contextWindow = state.model?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		if (includeContext) {
			const breakdown = this.getCachedContextBreakdown();
			contextTokens = breakdown.usedTokens;
			contextWindow = breakdown.contextWindow || contextWindow;
		}
		let contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		// Collab guest: context comes from the host's state frames — the local
		// replica does no accounting of its own.
		const collabState = this.#collabStatus?.stateOverride;
		if (collabState?.contextUsage) {
			contextWindow = collabState.contextUsage.contextWindow || contextWindow;
			contextPercent = collabState.contextUsage.percent ?? contextPercent;
		}

		return {
			session: this.session,
			focusedAgentId: this.#focusedAgentId,
			width,
			options: segmentOptions ?? {},
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			goalMode: this.#goalModeStatus,
			collab: this.#collabStatus,
			usageStats,
			contextPercent,
			contextWindow,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			sessionStartTime: this.#sessionStartTime,
			git: {
				branch: this.#getCurrentBranch(),
				status: this.#getGitStatus(),
				pr: this.#lookupPr(),
			},
			usage: this.#cachedUsage,
		};
	}

	#resolveSettings(): EffectiveStatusLineSettings {
		if (this.#effectiveSettings === undefined) {
			this.#effectiveSettings = this.#computeEffectiveSettings();
		}
		return this.#effectiveSettings;
	}

	#computeEffectiveSettings(): EffectiveStatusLineSettings {
		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.#settings,
			leftSegments,
			rightSegments,
			separator: this.#settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	#buildStatusLine(width: number): string {
		const effectiveSettings = this.#resolveSettings();
		const includeContext =
			hasContextSegment(effectiveSettings.leftSegments) || hasContextSegment(effectiveSettings.rightSegments);
		const ctx = this.#buildSegmentContext(width, effectiveSettings.segmentOptions, includeContext);
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		// `transparent` reuses the empty-string sentinel (`\x1b[49m`) so the bar
		// inherits the terminal's default background, matching custom themes that
		// set `statusLineBg: ""`. Powerline end caps need a contrasting fill to
		// bridge the bar into the surrounding terminal; without one they read as
		// stray glyphs, so the cap renderer drops them when the fill is empty.
		const TRANSPARENT_BG_ANSI = "\x1b[49m";
		const themeBgAnsi = theme.getBgAnsi("statusLineBg");
		const bgAnsi = effectiveSettings.transparent ? TRANSPARENT_BG_ANSI : themeBgAnsi;
		const transparentBg = bgAnsi === TRANSPARENT_BG_ANSI;
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		// Collect visible segment contents
		const leftParts: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		const rightParts: string[] = [];
		for (const segId of effectiveSettings.rightSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
			}
		}

		const runningBackgroundJobs = this.session.getAsyncJobSnapshot()?.running.length ?? 0;
		if (runningBackgroundJobs > 0) {
			rightParts.unshift(theme.fg("statusLineSubagents", `${theme.icon.job} ${runningBackgroundJobs}`));
		}
		const topFillWidth = Math.max(0, width);
		const left = [...leftParts];
		const right = [...rightParts];

		const leftSepWidth = visibleWidth(separatorDef.left);
		const rightSepWidth = visibleWidth(separatorDef.right);
		// Transparent mode drops powerline caps (they need a bg fill to bridge),
		// so the width budget excludes them too.
		const leftCapWidth = separatorDef.endCaps && !transparentBg ? visibleWidth(separatorDef.endCaps.right) : 0;
		const rightCapWidth = separatorDef.endCaps && !transparentBg ? visibleWidth(separatorDef.endCaps.left) : 0;

		const groupWidth = (parts: string[], capWidth: number, sepWidth: number): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
			const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
			return partsWidth + sepTotal + 2 + capWidth;
		};

		let leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
			}
			// Shrink path before dropping left segments — path is the only elastic segment
			const pathIdx = leftSegIds.indexOf("path");
			if (pathIdx >= 0 && totalWidth() > topFillWidth) {
				const overflow = totalWidth() - topFillWidth;
				const currentPathVW = visibleWidth(left[pathIdx]);
				const minPathVW = 8; // icon + ellipsis + a few chars
				const shrinkable = currentPathVW - minPathVW;
				if (shrinkable > 0) {
					const shrinkBy = Math.min(shrinkable, overflow);
					const currentMaxLen = ctx.options.path?.maxLength ?? 40;
					let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
					const pathCtx = (maxLen: number): SegmentContext => ({
						...ctx,
						options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
					});
					let reRendered = renderSegment("path", pathCtx(newMaxLen));
					if (reRendered.visible && reRendered.content) {
						// maxLength governs path text, not icon prefix; iterate to compensate
						for (let i = 0; i < 8; i++) {
							const saved = currentPathVW - visibleWidth(reRendered.content);
							if (saved >= shrinkBy) break;
							const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
							if (nextMaxLen >= newMaxLen) break; // no progress or hit floor
							newMaxLen = nextMaxLen;
							const adjusted = renderSegment("path", pathCtx(newMaxLen));
							if (!adjusted.visible || !adjusted.content) break;
							reRendered = adjusted;
						}
						left[pathIdx] = reRendered.content;
						leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
					}
				}
			}
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftSegIds.pop();
				leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const renderGroup = (parts: string[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;
			const cap =
				separatorDef.endCaps && !transparentBg
					? direction === "left"
						? separatorDef.endCaps.right
						: separatorDef.endCaps.left
					: "";
			const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
			const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

			let content = bgAnsi + fgAnsi;
			content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
			content += "\x1b[0m";

			if (capText) {
				return direction === "right" ? capText + content : content + capText;
			}
			return content;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		const sessionName =
			effectiveSettings.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName
			? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
			: undefined;
		const gapColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("border");
		const gapFill = `${gapColor}${theme.boxRound.horizontal.repeat(gapWidth)}\x1b[39m`;
		return leftGroup + gapFill + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		let content = this.#buildStatusLine(width);
		if (this.#focusedAgentId && content) {
			// Dim the whole bar while focus-proxied. Group/cap terminators emit full
			// `\x1b[0m` resets that would cancel faint mid-bar, so re-open it after each.
			content = `\x1b[2m${content.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
		}
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): readonly string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width)];
	}
}
