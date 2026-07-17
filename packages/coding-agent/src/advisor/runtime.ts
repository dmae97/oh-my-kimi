import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown, PRIMARY_CONTEXT_CUSTOM_TYPES } from "../session/session-history-format";

/**
 * Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core
 * `Agent`. `state.error` mirrors `Agent.state.error`: provider/stream failures
 * the loop catches internally never reject `prompt()`, so the runtime reads
 * this field after every prompt to detect a failed turn.
 */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	/**
	 * Drop messages appended past `count`. Called after a failed `prompt()` so a
	 * retry doesn't replay the failed user batch + synthetic assistant-error
	 * turn `Agent.#runLoop` records on its internal state.
	 */
	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor must clear its own context before sending the current
	 * incremental update. The cursor stays at the current primary position: this
	 * recovery path must never replay the full primary transcript.
	 * Optional: hosts that omit it get no proactive maintenance.
	 */
	maintainContext?(incomingTokens: number): Promise<boolean>;
	/**
	 * Called immediately before each `agent.prompt(batch)` cycle. Lets the host
	 * clear per-update advisor state — currently the one-advise-per-update gate
	 * in {@link AdvisorEmissionGuard}, which the host owns because it is the
	 * one that routes `advise()` results back to the primary.
	 */
	beginAdvisorUpdate?(): void;
	/**
	 * Called with the error of every failed advisor turn, before the retry sleep
	 * or the dropped-after-3 path. Lets the host apply credential-level remedies
	 * and configured model fallback that the advisor loop cannot perform itself.
	 * Return `true` after switching models so the same clean batch is retried
	 * immediately with a fresh failure budget. `failedMessages` contains the
	 * failed prompt's appended turns before rollback. Errors thrown here are
	 * logged and swallowed.
	 */
	onTurnError?(
		error: unknown,
		failedMessages: readonly AgentMessage[],
	): Promise<boolean | undefined> | boolean | undefined;
	/** Called after a successful advisor turn so the host can finish fallback lifecycle reporting. */
	onTurnSuccess?(): Promise<void> | void;
	/** Surface a non-recovering advisor failure to the host UI without adding model-visible context. */
	notifyFailure?(error: unknown): void;
	/** Signal that the advisor paused on a quota/rate-limit after host-level
	 *  recovery (credential switch, fallback chain) declined. Cleared only by
	 *  an explicit reset (`/new`, config rebuild, session restart). */
	notifyQuotaExhausted?(): void;
}

/**
 * A request rejection that no amount of retrying can fix for this advisor
 * configuration: the provider refuses the model/request shape outright (e.g.
 * "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a
 * ChatGPT account", code=invalid_request_error). Distinct from quota errors,
 * which pause via the dedicated quota path and auto-resume on reset.
 */
function isPermanentAdvisorError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist/i.test(message);
}

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";

/** Signals that an advisor response was discarded before it could become model-visible context. */
export class AdvisorOutputQuarantinedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisorOutputQuarantinedError";
	}
}

interface AdvisorOutputHazard {
	label: string;
	pattern: RegExp;
}

const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
	{ label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
	{
		label: "instruction override",
		pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
	},
	{
		label: "destructive shell command",
		pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i,
	},
	{ label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

/**
 * Replaces an advisor assistant turn that requested unavailable tools or generated
 * output-only destructive directives with a sanitized error before dispatch.
 *
 * The agent loop records assistant turns before dispatching tools. Without this
 * pre-dispatch rewrite, an advisor hallucination can leave unrelated text in the
 * advisor transcript even though the action itself never executes.
 */
export function quarantineAdvisorUnsafeOutput(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
	sourceText = "",
): string | undefined {
	const reasons: string[] = [];
	const unavailableToolNames = new Set<string>();
	const generatedParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && !availableToolNames.has(block.name)) unavailableToolNames.add(block.name);
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}
	if (unavailableToolNames.size > 0) {
		const names = [...unavailableToolNames].sort();
		const toolLabel = names.length === 1 ? "tool" : "tools";
		reasons.push(`requested unavailable ${toolLabel} ${names.join(", ")}`);
	}

	const generatedText = generatedParts.join("\n");
	if (generatedText) {
		const labels: string[] = [];
		const matchedLabels: string[] = [];
		for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
			if (!hazard.pattern.test(generatedText)) continue;
			matchedLabels.push(hazard.label);
			if (!hazard.pattern.test(sourceText)) labels.push(hazard.label);
		}
		// A transcript can quote a destructive command while the advisor turns it
		// into a new instruction. The output-only override remains sufficient
		// provenance to quarantine that combination.
		if (
			matchedLabels.includes("destructive shell command") &&
			labels.includes("instruction override") &&
			!labels.includes("destructive shell command")
		) {
			labels.push("destructive shell command");
		}
		if (labels.includes("destructive shell command") || labels.length >= 3) {
			reasons.push(`generated output-only destructive directives: ${labels.join(", ")}`);
		}
	}

	if (reasons.length === 0) return undefined;

	const messageText = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
	message.content = [{ type: "text", text: messageText }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.toolCallAbortMessages = undefined;
	message.providerPayload = undefined;
	message.errorMessage = messageText;
	return messageText;
}

/**
 * Builds the provenance text used to decide whether hazardous advisor output was
 * generated by the advisor or came from model-visible primary/tool context.
 */
export function buildAdvisorQuarantineSourceText(currentInput: string, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	if (currentInput) parts.push(currentInput);
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}
/**
 * Maximum number of late-arrival coalescing rounds in {@link AdvisorRuntime.#collectAndMaintainBatch}.
 * After this many rounds any items still in `#pending` are left for the next drain iteration
 * so a pathologically fast primary + slow `maintainContext` cannot stall dispatch indefinitely.
 */
const MAX_COALESCE_ROUNDS = 3;

const ADVISOR_RENDER_OPTIONS = {
	includeThinking: true,
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
} as const;

interface PendingDelta {
	text: string;
	rawMessages: AgentMessage[];
	renderRevision: number;
	turns: number;
	/** Whether the primary was mid-turn (willContinue:true) when this delta was rendered. */
	wip: boolean;
	overflowRecovery?: boolean;
}

interface CatchupWaiter {
	threshold: number;
	resolve: () => void;
	finish: () => void;
	timer?: NodeJS.Timeout;
}

interface DeliveredMessage {
	message: AgentMessage;
	fingerprint: bigint | undefined;
}

function fingerprintMessage(message: AgentMessage): bigint | undefined {
	try {
		const serialized = JSON.stringify(message);
		if (serialized === undefined) return undefined;
		return Bun.hash.wyhash(serialized);
	} catch {
		return undefined;
	}
}

export class AdvisorRuntime {
	#lastCount = 0;
	/**
	 * Delivered prefix identities. References make the normal append-only path
	 * allocation-free; fingerprints preserve identity across equivalent clones.
	 */
	#deliveredPrefix: DeliveredMessage[] = [];
	/** Last-shown body, keyed by primary-context customType (plan/goal mode rules,
	 *  approved plan). These prompts are re-injected verbatim every primary turn;
	 *  this lets {@link #renderDelta} collapse an unchanged copy to a one-line
	 *  marker so the advisor isn't re-fed the full ~1k-token rules each turn.
	 *  Cleared on every re-prime/seed and when a failed batch is dropped. */
	#seenContext = new Map<string, string>();
	/** Incremented whenever the advisor loses context so queued raw deltas are re-rendered against fresh dedupe state. */
	#renderRevision = 0;
	#pending: PendingDelta[] = [];
	#busy = false;
	#backlog = 0;
	#consecutiveFailures = 0;
	#failureNotified = false;
	/** Completed 3-failure backlog-drop cycles since the last success/reset. */
	#droppedBacklogs = 0;
	/**
	 * Hard stop after repeated drop cycles or a permanent request rejection
	 * (e.g. "model not supported"): without it the advisor re-attempts on every
	 * new delta forever, and in a shared daemon that unbounded churn burns CPU
	 * and starves every hosted session's event loop. Cleared only by an
	 * explicit {@link reset} (config rebuild, /new, session restart).
	 */
	#halted = false;
	/** True from the moment an advisor turn fails until one succeeds (or an
	 *  explicit reset/seed). While set, {@link waitForCatchup} resolves
	 *  immediately: the primary agent NEVER parks on a failing advisor. */
	#failing = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	disposed = false;
	/** Quota/rate-limit pause state. When `true`, the advisor stops processing
	 *  turns and drops new deltas until an explicit {@link reset} clears it
	 *  (triggered by `/new`, config rebuild, or session restart). There is no
	 *  timer-based auto-resume: provider quota windows (5h/7d) are far longer
	 *  than any reasonable timer, and premature retries waste calls and
	 *  re-trigger the same error. */
	#quotaExhausted = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}
	get quotaExhausted(): boolean {
		return this.#quotaExhausted;
	}
	get failureNotified(): boolean {
		return this.#failureNotified;
	}
	/** True after the runtime hard-stopped on repeated or permanent failures. */
	get halted(): boolean {
		return this.#halted;
	}

	/**
	 * True when `#pending` is non-empty while the drain loop is busy — i.e., newer
	 * primary turns arrived after the current batch's transcript window was fixed
	 * but before the advisor model finished processing it. The delivery path uses
	 * this to annotate advice that was generated without seeing those newer turns.
	 * Can be true during `agent.prompt()`, a `maintainContext` await, or a retry
	 * sleep — any time `#drain` is busy and a concurrent `onTurnEnd` pushed.
	 */
	get hasFreshBacklog(): boolean {
		return this.#pending.length > 0;
	}

	/**
	 * Called after each primary turn ends. Renders the incremental delta and
	 * queues it for the advisor model.
	 *
	 * @param messages - Live primary transcript snapshot (defaults to `snapshotMessages()`).
	 * @param opts.willContinue - When `true` the primary is mid-turn (more tool-call
	 *   steps will follow). The rendered heading is tagged `[in progress]` so the
	 *   advisor knows to withhold critique on partial work. The flag is carried on
	 *   the delta and forwarded to the reprime path so it is never silently dropped.
	 */
	onTurnEnd(messages?: AgentMessage[], opts?: { willContinue?: boolean }): void {
		if (this.disposed || this.#quotaExhausted || this.#halted) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const wip = opts?.willContinue ?? false;
		let rendered: Omit<PendingDelta, "turns" | "overflowRecovery"> | null = null;
		// #renderDelta advances the cursor/prefix/dedup state before formatting
		// can throw; snapshot them so a formatter bug loses NOTHING — the next
		// turn re-renders this delta (a prefix change mid-render self-heals via
		// the fingerprint scan, at worst costing one full replay).
		const cursorBefore = this.#lastCount;
		const prefixBefore = this.#deliveredPrefix.slice();
		const seenBefore = [...this.#seenContext];
		try {
			rendered = this.#renderDelta(all, wip);
		} catch (err) {
			// A render bug must never propagate into the primary agent's
			// turn-end callback: the advisor skips this delta and stops gating
			// the catch-up wait until a turn succeeds.
			this.#lastCount = cursorBefore;
			this.#deliveredPrefix = prefixBefore;
			this.#seenContext.clear();
			for (const [key, value] of seenBefore) this.#seenContext.set(key, value);
			this.#failing = true;
			this.#wakeAllWaiters();
			logger.warn("advisor delta render failed", { err: String(err) });
		}
		if (rendered) {
			this.#pending.push({ ...rendered, turns: 1 });
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		}
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<void> {
		if (
			this.disposed ||
			signal?.aborted ||
			this.#backlog < threshold ||
			this.#quotaExhausted ||
			this.#halted ||
			// An advisor mid-failure/retry must NEVER gate the primary agent:
			// its backlog cannot drain until the retry cycle resolves, and the
			// primary would otherwise park for the full catch-up budget.
			this.#failing
		)
			return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let waiter!: CatchupWaiter;
		const finish = (): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		waiter = { threshold, resolve, finish, timer: setTimeout(finish, maxMs) };
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted) {
			finish();
		}
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#clearSeenContext(): void {
		this.#seenContext.clear();
		this.#renderRevision++;
	}

	#clearAdvisorContextAtCurrentCursor(): void {
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#clearSeenContext();
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean): void {
		this.#lastCount = 0;
		this.#deliveredPrefix = [];
		this.#pending = [];
		this.#clearAdvisorContextAtCurrentCursor();
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
	}

	/**
	 * Account one completed 3-failure backlog-drop cycle. Repeated cycles (or a
	 * single permanent request rejection, e.g. "model not supported") hard-stop
	 * the runtime: in a shared daemon, unbounded advisor churn re-builds heavy
	 * context on every new delta and starves every hosted session's event loop.
	 * Only an explicit {@link reset} (config rebuild, /new, restart) resumes.
	 */
	#noteDroppedBacklog(error: unknown): void {
		this.#droppedBacklogs++;
		if (this.#droppedBacklogs < 3 && !isPermanentAdvisorError(error)) return;
		this.#halted = true;
		this.#pending = [];
		this.#wakeAllWaiters();
		logger.warn("advisor halted after repeated failures; use /advisor or reload config to re-enable", {
			droppedBacklogs: this.#droppedBacklogs,
			err: String(error),
		});
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#epoch++;
		this.#quotaExhausted = false;
		this.#halted = false;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#resetAdvisorContext(true, true);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		const messages = this.host.snapshotMessages().slice(0, count);
		this.#lastCount = messages.length;
		this.#deliveredPrefix = messages.map(message => ({
			message,
			fingerprint: fingerprintMessage(message),
		}));
		this.#pending = [];
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#failureNotified = false;
		this.#clearSeenContext();
		this.#wakeAllWaiters();
	}

	#formatRawDelta(rawMessages: AgentMessage[], wip = false): string | null {
		const delta = rawMessages
			.filter(message => !(message.role === "custom" && message.customType === "advisor"))
			.map(message => this.#dedupContextMessage(message));
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		const formattedDelta = obfuscator?.hasSecrets() ? obfuscateAdvisorDelta(obfuscator, delta) : delta;
		const md = formatSessionHistoryMarkdown(formattedDelta, ADVISOR_RENDER_OPTIONS);
		if (!md.trim()) return null;
		const heading = wip ? "### Session update [in progress — more steps follow]" : "### Session update";
		return `${heading}\n\n${md}`;
	}

	#renderDelta(messages?: AgentMessage[], wip = false): Omit<PendingDelta, "turns" | "overflowRecovery"> | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		let prefixChanged = all.length < this.#lastCount;
		for (let i = 0; !prefixChanged && i < this.#lastCount; i++) {
			const delivered = this.#deliveredPrefix[i];
			const current = all[i];
			if (delivered === undefined || current === undefined) {
				prefixChanged = true;
				break;
			}
			if (delivered.message === current) continue;
			const fingerprint = fingerprintMessage(current);
			if (
				delivered.fingerprint === undefined ||
				fingerprint === undefined ||
				delivered.fingerprint !== fingerprint
			) {
				prefixChanged = true;
				break;
			}
			delivered.message = current;
		}
		if (prefixChanged) {
			this.#epoch++;
			this.#resetAdvisorContext(true, true);
		}
		const rawMessages = all.slice(this.#lastCount);
		for (let i = this.#lastCount; i < all.length; i++) {
			const message = all[i];
			if (message === undefined) continue;
			this.#deliveredPrefix.push({ message, fingerprint: fingerprintMessage(message) });
		}
		this.#lastCount = all.length;
		const text = this.#formatRawDelta(rawMessages, wip);
		return text ? { text, rawMessages, renderRevision: this.#renderRevision, wip } : null;
	}

	/**
	 * Collapse a re-injected primary-context prompt (plan/goal mode rules, the
	 * approved plan) to a short marker when its body is byte-identical to the
	 * copy already shown to the advisor since the last re-prime. The primary
	 * re-injects these verbatim every turn; without this the advisor re-reads the
	 * full rules (~1k tokens) each turn. Returns a CLONE when collapsing — the
	 * input shares the live primary transcript and must never be mutated.
	 */
	#dedupContextMessage(msg: AgentMessage): AgentMessage {
		if (msg.role !== "custom") return msg;
		// Narrowed to CustomMessage: customType and content are properly typed.
		if (!PRIMARY_CONTEXT_CUSTOM_TYPES.has(msg.customType)) return msg;
		if (typeof msg.content !== "string") return msg;
		if (this.#seenContext.get(msg.customType) === msg.content) {
			return { ...msg, content: "(unchanged — still in effect)" };
		}
		this.#seenContext.set(msg.customType, msg.content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish();
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish();
		}
	}

	/**
	 * Drop the user batch + synthetic assistant-error turn `Agent.#runLoop`
	 * appended for a failed prompt so a retry replays a clean baseline and the
	 * dropped-after-3 path never leaks orphan failures into the next successful
	 * run. Prefers the agent's own `rollbackTo` (which also re-syncs its
	 * append-only context); falls back to truncating `state.messages` for tests
	 * that hand-roll a minimal facade.
	 */
	#rollbackFailedTurn(snapshot: number): void {
		const messages = this.agent.state.messages;
		if (messages.length <= snapshot) return;
		try {
			if (this.agent.rollbackTo) {
				this.agent.rollbackTo(snapshot);
				return;
			}
			messages.length = snapshot;
		} catch (err) {
			logger.debug("advisor rollback failed", { err: String(err) });
		}
	}

	/**
	 * Collect the popped deltas into one batch, running `maintainContext` for
	 * correct token budgeting. Loops until the pending queue is stable (no new
	 * deltas arrived during a maintenance check) or the round cap is reached.
	 * Every `await` inside the loop has an epoch guard so a reset/dispose
	 * mid-await cannot leak a stale batch into the post-reset conversation.
	 *
	 * When maintenance requests recovery, only the advisor Agent/log is reset
	 * (at the current primary cursor) and the already-collected raw batch is
	 * re-rendered — older, already-delivered primary transcript is never
	 * replayed.
	 *
	 * The coalescing loop is capped at {@link MAX_COALESCE_ROUNDS} iterations so
	 * a pathologically fast primary combined with a slow `maintainContext` cannot
	 * stall dispatch indefinitely — any items still in `#pending` after the cap
	 * are left for the next drain iteration. Overflow-recovery batches skip
	 * coalescing entirely: they retry exactly the bounded batch that overflowed.
	 *
	 * Returns `null` when the epoch was invalidated — caller should `continue`.
	 */
	async #collectAndMaintainBatch(
		epoch: number,
		initial: PendingDelta[],
		recoveringOverflow: boolean,
	): Promise<{
		batch: string | null;
		rawMessages: AgentMessage[];
		finalTurns: number;
		wip: boolean;
		resetContext: boolean;
	} | null> {
		let batchText = initial.map(b => b.text).join("\n\n");
		let rawMessages = initial.flatMap(b => b.rawMessages);
		let turns = initial.reduce((sum, b) => sum + b.turns, 0);
		// Track WIP state of the most recent delta — forwarded to the re-render
		// so a willContinue:true turn keeps its [in progress] heading. Also
		// returned to #drain so the retry-requeue path preserves it on failed turns.
		let wip = initial.at(-1)?.wip ?? false;

		for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
			if (this.host.maintainContext) {
				const incomingTokens = estimateTokens({ role: "user", content: batchText, timestamp: Date.now() });
				let shouldResetContext = false;
				try {
					shouldResetContext = await this.host.maintainContext(incomingTokens);
				} catch (err) {
					logger.debug("advisor context maintenance failed", { err: String(err) });
				}
				// Epoch guard — a reset/dispose during the maintainContext await
				// invalidates this batch.
				if (this.#epoch !== epoch) return null;

				if (shouldResetContext) {
					// Once coalescing has begun (round > 0), deltas that arrived during
					// this await are part of the coalescing window: tally them so
					// finalTurns stays accurate for backlog accounting and their raw
					// messages join the bounded re-render. On the initial round the
					// popped batch stays bounded exactly as dispatched — later arrivals
					// remain queued and ship as their own subsequent batch.
					if (round > 0) {
						const lateItems = this.#pending.splice(0);
						turns += lateItems.reduce((sum, b) => sum + b.turns, 0);
						if (lateItems.length > 0) {
							wip = lateItems.at(-1)!.wip;
							rawMessages = rawMessages.concat(lateItems.flatMap(b => b.rawMessages));
						}
					}
					// Reset only the advisor Agent/log. The primary cursor, backlog,
					// waiters, latest snapshot, and epoch stay untouched. Re-render only
					// this already-popped raw batch so active plan/reference bodies are
					// restored without replaying any older primary transcript.
					this.#clearAdvisorContextAtCurrentCursor();
					const rerendered = this.#formatRawDelta(rawMessages, wip);
					return {
						batch: rerendered ?? (batchText || null),
						rawMessages,
						finalTurns: turns,
						wip,
						resetContext: true,
					};
				}
			}

			// Overflow-recovery batches retry exactly the bounded batch that
			// overflowed; pending updates stay queued behind them.
			if (recoveringOverflow) break;

			// On the final round stop here — any late arrivals would ship without
			// a subsequent maintainContext budget check. Leave them in #pending for
			// the next drain iteration where they will be properly budgeted.
			if (round === MAX_COALESCE_ROUNDS - 1) break;

			// Coalesce any deltas that arrived while we were awaiting maintenance.
			// If none arrived the batch is stable and we're done; otherwise merge,
			// update WIP state, and re-check the maintenance budget.
			const late = this.#pending.splice(0);
			if (late.length === 0) break;
			batchText = [batchText, ...late.map(b => b.text)].join("\n\n");
			rawMessages = rawMessages.concat(late.flatMap(b => b.rawMessages));
			turns += late.reduce((sum, b) => sum + b.turns, 0);
			wip = late.at(-1)!.wip;
		}

		return { batch: batchText || null, rawMessages, finalTurns: turns, wip, resetContext: false };
	}

	#terminalAssistantFailure(snapshot: number): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= snapshot; i--) {
			const message = messages[i];
			if (message.role === "assistant" && message.stopReason === "error") return message;
		}
		return undefined;
	}

	#notifyFailureOnce(error: unknown): void {
		if (this.#failureNotified) return;
		this.#failureNotified = true;
		try {
			this.host.notifyFailure?.(error);
		} catch (notifyErr) {
			logger.warn("advisor failure notification failed", { err: String(notifyErr) });
		}
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				let popped: PendingDelta[];
				if (this.#pending[0]?.overflowRecovery) {
					const recovery = this.#pending.shift();
					if (!recovery) continue;
					popped = [recovery];
				} else {
					popped = this.#pending.splice(0);
				}
				const epoch = this.#epoch;
				for (const delta of popped) {
					if (delta.renderRevision === this.#renderRevision) continue;
					const refreshed = this.#formatRawDelta(delta.rawMessages, delta.wip);
					if (refreshed) delta.text = refreshed;
					delta.renderRevision = this.#renderRevision;
				}
				const recoveringOverflow = popped.some(delta => delta.overflowRecovery === true);
				const result = await this.#collectAndMaintainBatch(epoch, popped, recoveringOverflow);

				// Epoch was invalidated during batch collection; restart the loop.
				if (result === null) continue;

				const { batch, rawMessages, finalTurns, wip, resetContext } = result;

				if (this.disposed || batch === null) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}

				let success = false;
				// Capture the advisor's message count BEFORE the prompt so a failure can
				// roll back the user batch + synthetic assistant-error turn Agent.#runLoop
				// appends to internal state. Without this, a retry would replay the failed
				// batch on top of stale turns and the dropped-after-3 path would leak
				// orphan failures into the next successful run's context.
				const messageSnapshot = this.agent.state.messages.length;
				const contextWasFresh = resetContext || recoveringOverflow || messageSnapshot === 0;
				try {
					// Reset the host's per-update advisor state (one-advise-per-update
					// gate) before each model cycle so the new batch starts fresh.
					this.host.beginAdvisorUpdate?.();
					await this.agent.prompt(batch);
					// Agent.#runLoop catches provider/stream failures internally and
					// resolves prompt() cleanly with stopReason: "error". Treat that
					// as a failed turn so endpoint rejections trip the retry path.
					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);
					// A content-less stop is a deliberate silent review — the documented
					// verifier behavior ("prefer silence when the agent is on track") — and
					// completes the turn. Sessions can legitimately have nothing to advise
					// on for any number of consecutive turns, so silence is never warned
					// about (#5216 did, spamming "Advisor unavailable" at quiet models).
					const turnError = getAdvisorTurnError(this.agent.state.messages.slice(messageSnapshot));
					if (turnError) throw turnError;
					success = true;
					this.#failing = false;
					this.#consecutiveFailures = 0;
					this.#failureNotified = false;
					this.#droppedBacklogs = 0;
					if (this.host.onTurnSuccess) {
						try {
							await this.host.onTurnSuccess();
						} catch (hookErr) {
							logger.debug("advisor onTurnSuccess hook failed", { err: String(hookErr) });
						}
					}
				} catch (err) {
					// reset()/dispose() aborts the in-flight prompt; treat it as a
					// reset, not a transient failure — drop the stale batch.
					if (this.#epoch !== epoch) continue;
					// Release any parked primary-agent waiters IMMEDIATELY — before
					// the async onTurnError hook or any retry sleep — and refuse new
					// parks until a turn succeeds. A failing advisor must never hold
					// the primary on the catch-up gate.
					this.#failing = true;
					this.#wakeAllWaiters();
					const failedMessages = this.agent.state.messages.slice(messageSnapshot);
					const terminalFailure = this.#terminalAssistantFailure(messageSnapshot);
					const terminalFailureId =
						terminalFailure === undefined ? undefined : AIError.classifyMessage(terminalFailure);
					const contextOverflow =
						(terminalFailureId !== undefined && AIError.is(terminalFailureId, AIError.Flag.ContextOverflow)) ||
						AIError.is(AIError.classify(err), AIError.Flag.ContextOverflow);
					// A terminal provider failure that is neither retriable nor an
					// overflow (e.g. a blocked prompt) will fail identically on every
					// retry — classify it before rollback so the batch is dropped after
					// one attempt instead of burning the 3-attempt budget (#5468).
					const terminalFailureRetriable =
						terminalFailureId === undefined ||
						AIError.retriable(terminalFailureId) ||
						AIError.is(terminalFailureId, AIError.Flag.ContextOverflow);
					this.#rollbackFailedTurn(messageSnapshot);
					logger.debug("advisor turn failed", { err: String(err) });
					let recovered = false;
					try {
						recovered = (await this.host.onTurnError?.(err, failedMessages)) === true;
					} catch (hookErr) {
						logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
					}
					if (err instanceof AdvisorOutputQuarantinedError) {
						const rePrime = this.#pending.length > 0 ? this.#latestMessages : undefined;
						// Wake catchup waiters only when nothing is re-primed; otherwise the
						// re-primed turn restores the backlog and waiters resolve on its completion.
						this.#resetAdvisorContext(true, !rePrime);
						if (rePrime) this.onTurnEnd(rePrime);
						continue;
					}
					// Epoch guard after the async error hook.
					if (this.#epoch !== epoch) continue;
					if (recovered) {
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#pending.unshift({
							text: batch,
							rawMessages,
							renderRevision: this.#renderRevision,
							turns: finalTurns,
							wip,
							overflowRecovery: recoveringOverflow || undefined,
						});
						continue;
					}
					if (AIError.isUsageLimit(err)) {
						// Host recovery (credential switch / fallback chain) declined:
						// pause on the quota latch instead of burning retries — provider
						// quota windows (5h/7d) outlast any retry budget. The batch is
						// requeued and the backlog stays visible so reset() replays it.
						logger.warn("advisor quota exhausted", { err: String(err) });
						this.#quotaExhausted = true;
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#clearSeenContext();
						this.#pending.unshift({
							text: batch,
							rawMessages,
							renderRevision: this.#renderRevision,
							turns: finalTurns,
							wip,
							overflowRecovery: recoveringOverflow || undefined,
						});
						this.#wakeAllWaiters();
						try {
							this.host.notifyQuotaExhausted?.();
						} catch (notifyErr) {
							logger.warn("advisor quota notification failed", { err: String(notifyErr) });
						}
						break;
					}
					if (!terminalFailureRetriable) {
						logger.warn("advisor terminal failure is non-retriable; dropping bounded batch");
						this.#notifyFailureOnce(err);
						this.#consecutiveFailures = 0;
						// The dropped batch may carry primary-context we never delivered; drop
						// the seen-state too so queued raw deltas re-expand before delivery.
						this.#clearSeenContext();
						this.#noteDroppedBacklog(err);
						success = true;
					} else if (contextOverflow) {
						this.#clearAdvisorContextAtCurrentCursor();
						if (contextWasFresh) {
							// The bounded update cannot fit even with no advisor history. Drop
							// only this batch after its one fresh-context retry; pending and later
							// deltas remain eligible so one oversized update cannot disable the advisor.
							logger.warn("advisor update overflowed a fresh context; dropping bounded batch");
							this.#notifyFailureOnce(err);
							success = true;
						} else {
							// Retry once against the fresh advisor context, using only the same
							// bounded raw batch. Pending updates remain queued behind it.
							const recoveryBatch = this.#formatRawDelta(rawMessages, wip) ?? batch;
							this.#pending.unshift({
								text: recoveryBatch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: true,
							});
							logger.debug("advisor context overflow recovered at current primary cursor");
						}
					} else {
						this.#consecutiveFailures++;
						if (this.#consecutiveFailures >= 3) {
							logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
							this.#notifyFailureOnce(err);
							this.#consecutiveFailures = 0;
							// The dropped batch may carry primary-context we never delivered; drop
							// the seen-state too so queued raw deltas re-expand before delivery.
							this.#clearSeenContext();
							this.#noteDroppedBacklog(err);
							success = true;
						} else {
							this.#pending.unshift({
								text: batch,
								rawMessages,
								renderRevision: this.#renderRevision,
								turns: finalTurns,
								wip,
								overflowRecovery: recoveringOverflow || undefined,
							});
							await Bun.sleep(this.retryDelayMs);
						}
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}

/**
 * The only malformed advisor turn shape: the prompt resolved but produced no
 * assistant response at all. Everything an assistant message carries — advice,
 * reasoning, or deliberate silence (empty `stop`) — is a completed review.
 */
function getAdvisorTurnError(messages: readonly AgentMessage[]): Error | undefined {
	if (messages.length === 0) return undefined;
	if (messages.some(message => message.role === "assistant")) return undefined;
	return new Error("Advisor turn ended without an assistant response");
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(obfuscator: SecretObfuscator, content: TextualContent): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function obfuscateAssistantMessage(obfuscator: SecretObfuscator, message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details);
}

function obfuscateAdvisorMessage(obfuscator: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(obfuscator, message.content as TextualContent);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(obfuscator, message as AssistantMessage) as AgentMessage;
		case "custom":
		case "hookMessage": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string; output: string };
			const command = obfuscator.obfuscate(msg.command);
			const output = obfuscator.obfuscate(msg.output);
			return command === msg.command && output === msg.output
				? message
				: ({ ...(message as object), command, output } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string; output: string };
			const code = obfuscator.obfuscate(msg.code);
			const output = obfuscator.obfuscate(msg.output);
			return code === msg.code && output === msg.output
				? message
				: ({ ...(message as object), code, output } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path);
				const content = obfuscator.obfuscate(file.content);
				if (path === file.path && content === file.content) return file;
				changed = true;
				return { ...file, path, content };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function obfuscateAdvisorDelta(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	let changed = false;
	const result = messages.map(message => {
		const next = obfuscateAdvisorMessage(obfuscator, message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? result : messages;
}
