import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { coerceServiceTierByFamily, type ProviderPayload, type ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	isCustomMessageContent,
	normalizeCustomMessagePayload,
} from "./messages";
import { type CompactionEntry, EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";

// #4470 crash artifacts had legacy frames (no shape metadata) with 17 frames,
// ~306k archive chars, and ~1.5M truncated chars. Current snapcompact frames
// carry shape metadata; only legacy archives with frame payload risk get this
// conservative LLM-payload guard, and transcript rendering remains intact.
const LEGACY_SNAPCOMPACT_FRAME_COUNT_GUARD = 16;
const LEGACY_SNAPCOMPACT_ARCHIVE_TEXT_GUARD = 250_000;
const LEGACY_SNAPCOMPACT_TRUNCATED_CHARS_GUARD = 1_000_000;

function hasLegacySnapcompactFrames(archive: snapcompact.Archive): boolean {
	return archive.frames.some(frame => frame.font === undefined && frame.variant === undefined);
}

function hasCrashRiskSnapcompactFramePayload(archive: snapcompact.Archive): boolean {
	return (
		archive.frames.length >= LEGACY_SNAPCOMPACT_FRAME_COUNT_GUARD ||
		snapcompact.frameDataBytes(archive.frames) >= snapcompact.FRAME_DATA_BYTES_BUDGET
	);
}

function hasCrashRiskSnapcompactArchiveSize(archive: snapcompact.Archive): boolean {
	return (
		archive.frames.length >= LEGACY_SNAPCOMPACT_FRAME_COUNT_GUARD ||
		archive.truncatedChars >= LEGACY_SNAPCOMPACT_TRUNCATED_CHARS_GUARD ||
		(snapcompact.archiveSourceText(archive)?.length ?? 0) >= LEGACY_SNAPCOMPACT_ARCHIVE_TEXT_GUARD
	);
}

function isCrashRiskLegacySnapcompactArchive(archive: snapcompact.Archive): boolean {
	return (
		hasLegacySnapcompactFrames(archive) &&
		hasCrashRiskSnapcompactFramePayload(archive) &&
		hasCrashRiskSnapcompactArchiveSize(archive)
	);
}

function snapcompactHistoryBlockOptions(
	archive: snapcompact.Archive,
	options: BuildSessionContextOptions | undefined,
): snapcompact.HistoryBlockOptions | undefined {
	if (options?.transcript) return undefined;
	if (isCrashRiskLegacySnapcompactArchive(archive)) return { maxFrameDataBytes: 0 };
	return { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET };
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel?: string;
	/** Configured thinking selector (`"auto"` or a concrete level) from the latest change. */
	configuredThinkingLevel?: string;
	serviceTier?: ServiceTierByFamily;
	/** Model roles: { default: "provider/modelId", small: "provider/modelId", ... } */
	models: Record<string, string>;
	/** Names of TTSR rules that have been injected this session */
	injectedTtsrRules: string[];
	/** Active mode (e.g. "plan") or "none" if no special mode is active */
	mode: string;
	/** Mode-specific data from the last mode_change entry */
	modeData?: Record<string, unknown>;
	/**
	 * Array parallel to messages, indicating which assistant turns should
	 * have their prompt-cache misses suppressed/explained (because a model,
	 * compaction, or plan-mode transition directly preceded them).
	 * Only populated in transcript mode.
	 */
	cacheMissExplainedAt?: boolean[];
}

/** Lists session model strings to try when restoring, in fallback order. */
export function getRestorableSessionModels(
	models: Readonly<Record<string, string>>,
	lastModelChangeRole: string | undefined,
): string[] {
	const defaultModel = models.default;
	if (
		!lastModelChangeRole ||
		lastModelChangeRole === "default" ||
		lastModelChangeRole === EPHEMERAL_MODEL_CHANGE_ROLE
	) {
		return defaultModel ? [defaultModel] : [];
	}

	const roleModel = models[lastModelChangeRole];
	if (!roleModel) return defaultModel ? [defaultModel] : [];
	if (!defaultModel || roleModel === defaultModel) return [roleModel];
	return [roleModel, defaultModel];
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export interface BuildSessionContextOptions {
	/**
	 * Build the display transcript instead of the LLM context. By default this
	 * preserves every path entry with compactions inline; set
	 * `collapseCompactedHistory` for the live TUI surface to render only the
	 * latest compacted tail.
	 */
	transcript?: boolean;
	/** In transcript mode, elide entries replaced by the latest compaction. */
	collapseCompactedHistory?: boolean;
	/**
	 * Transcript mode only: keep `toolCall` blocks that have no matching
	 * `toolResult` on the path instead of stripping them. Pass this when the
	 * session is mid-turn (a tool is still executing, its result not yet
	 * persisted) so the rebuilt transcript renders the in-flight call as
	 * pending; without it a focus/unfocus or overlay-close rebuild silently
	 * hides the call the agent is still waiting on.
	 */
	keepDanglingToolCalls?: boolean;
}

/**
 * Display-only marker set on transcript assistant messages whose dangling
 * `toolCall` blocks were stripped (no paired result on the resolved path —
 * failed/retried turns, results on sibling branches). The TUI renders a
 * placeholder row from it so the turn's activity never silently vanishes.
 */
export interface StrippedToolCallsMarker {
	strippedToolCalls?: number;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
function snapcompactHistoryBlocksForContext(
	archive: snapcompact.Archive | undefined,
	options: BuildSessionContextOptions | undefined,
) {
	if (!archive) return undefined;
	if (options?.transcript && options.collapseCompactedHistory) return undefined;
	return snapcompact.historyBlocks(archive, snapcompactHistoryBlockOptions(archive, options));
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options?: BuildSessionContextOptions,
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
	}

	// Walk from leaf to root, collecting path
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	// Extract settings and find compaction
	let thinkingLevel: string | undefined = "off";
	let configuredThinkingLevel: string | undefined;
	let serviceTier: ServiceTierByFamily | undefined;
	const models: Record<string, string> = {};
	let compaction: CompactionEntry | null = null;
	const injectedTtsrRulesSet = new Set<string>();
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;
	// Track whether an explicit `model_change` with role="default" has been
	// seen on this path. Once a user (or the agent itself) records an
	// explicit default, later assistant-message inference must NOT overwrite
	// it: temporary fallbacks (retry fallback, context promotion) and
	// server-side model downgrades both produce assistant messages tagged
	// with the wrong model id, which previously clobbered the user's pick on
	// resume (issue #849).
	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
			// New format: { model: "provider/id", role?: string }
			if (entry.model) {
				const role = entry.role ?? "default";
				models[role] = entry.model;
				if (role === "default") {
					hasExplicitDefaultModel = true;
				}
			}
		} else if (entry.type === "service_tier_change") {
			serviceTier = coerceServiceTierByFamily(entry.serviceTier);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// Legacy fallback: infer default model from assistant messages only
			// when no explicit `model_change` (role=default) entry has been
			// recorded yet. Newer sessions always record an explicit default
			// model_change at the start of the conversation, so this branch is
			// only used to keep pre-model_change sessions working.
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction") {
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
			// Collect injected TTSR rule names
			for (const ruleName of entry.injectedRules) {
				injectedTtsrRulesSet.add(ruleName);
			}
		} else if (entry.type === "mode_change") {
			mode = entry.mode;
			modeData = entry.data;
		}
	}

	const injectedTtsrRules = Array.from(injectedTtsrRulesSet);

	// Build messages and collect corresponding entries
	// When there's a compaction, we need to:
	// 1. Emit summary first (entry = compaction)
	// 2. Emit kept messages (from firstKeptEntryId up to compaction)
	// 3. Emit messages after compaction
	const messages: AgentMessage[] = [];
	const cacheMissExplainedAt: boolean[] = [];
	let pendingReset = false;
	let currentMode = "none";
	let lastAssistantModel: string | undefined;

	const handleEntryResetTracking = (entry: SessionEntry) => {
		if (entry.type === "compaction") {
			pendingReset = true;
		} else if (entry.type === "model_change") {
			pendingReset = true;
		} else if (entry.type === "mode_change") {
			const isPlanTransition = (entry.mode === "plan") !== (currentMode === "plan");
			if (isPlanTransition) {
				pendingReset = true;
			}
			currentMode = entry.mode;
		}
	};

	const pushMessage = (msg: AgentMessage) => {
		messages.push(msg);
		if (!options?.transcript) return;
		if (msg.role === "assistant") {
			const currentModel = `${msg.provider}/${msg.model}`;
			const modelChanged = lastAssistantModel !== undefined && lastAssistantModel !== currentModel;
			lastAssistantModel = currentModel;
			cacheMissExplainedAt.push(pendingReset || modelChanged);
			pendingReset = false;
		} else {
			cacheMissExplainedAt.push(false);
		}
	};

	const appendMessage = (entry: SessionEntry) => {
		handleEntryResetTracking(entry);
		if (entry.type === "message") {
			if (
				!options?.transcript &&
				entry.message.role === "assistant" &&
				entry.message.retryRecovery?.status === "recovered"
			) {
				return;
			}
			pushMessage(entry.message);
		} else if (entry.type === "custom_message") {
			if (!isCustomMessageContent(entry.content)) return;
			const normalized = normalizeCustomMessagePayload(entry);
			const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
			pushMessage(
				createCustomMessage(
					normalized.customType,
					normalized.content,
					normalized.display,
					normalized.details,
					entry.timestamp,
					attribution,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			pushMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (options?.transcript && !options.collapseCompactedHistory) {
		// Display transcript: every entry in chronological order. Compactions do
		// not erase prior history here — each renders inline (as a divider in the
		// TUI) at the point it fired, with any snapcompact frames re-attached so
		// the component can report them.
		for (const entry of path) {
			handleEntryResetTracking(entry);
			if (entry.type === "compaction") {
				const snapcompactArchive = snapcompact.getPreservedArchive(entry.preserveData);
				pushMessage(
					createCompactionSummaryMessage(
						entry.summary,
						entry.tokensBefore,
						entry.timestamp,
						entry.shortSummary,
						undefined,
						undefined,
						snapcompactHistoryBlocksForContext(snapcompactArchive, options),
						entry.warning,
					),
				);
			} else {
				appendMessage(entry);
			}
		}
	} else if (compaction) {
		const providerPayload: ProviderPayload | undefined = (() => {
			const candidate = compaction.preserveData?.openaiRemoteCompaction;
			if (!candidate || typeof candidate !== "object") return undefined;
			const remote = candidate as { provider?: unknown; replacementHistory?: unknown };
			if (typeof remote.provider !== "string" || remote.provider.length === 0) return undefined;
			if (!Array.isArray(remote.replacementHistory)) return undefined;
			return {
				type: "openaiResponsesHistory",
				provider: remote.provider,
				items: remote.replacementHistory as Array<Record<string, unknown>>,
			};
		})();
		const remoteReplacementHistory = providerPayload?.items;

		// Re-attach any archived snapcompact frames so the model can keep
		// reading the archived history after every context rebuild.
		const snapcompactArchive = snapcompact.getPreservedArchive(compaction.preserveData);
		const compactionSummaryMsg = createCompactionSummaryMessage(
			compaction.summary,
			compaction.tokensBefore,
			compaction.timestamp,
			compaction.shortSummary,
			providerPayload,
			undefined,
			snapcompactHistoryBlocksForContext(snapcompactArchive, options),
			compaction.warning,
		);
		// Agent context (non-transcript): summary first so the LLM sees the
		// compacted context before recent messages.
		if (!options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		// Find compaction index in path
		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

		// The remote replacement payload (OpenAI remote compaction) carries the
		// kept turns for the LLM context only; it is not rendered as visible
		// messages. The collapsed display transcript must still emit the kept
		// SessionEntry rows so a remotely-compacted session keeps its recent
		// turns visible instead of showing only the summary and post-compaction.
		if (!remoteReplacementHistory || options?.transcript) {
			// Emit kept messages (before compaction, starting from firstKeptEntryId)
			let foundFirstKept = false;
			for (let i = 0; i < compactionIdx; i++) {
				const entry = path[i];
				if (entry.id === compaction.firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (foundFirstKept) {
					appendMessage(entry);
				}
			}
		}

		// Display transcript: emit the summary at the chronological compaction
		// point (after kept messages, before post-compaction) so it stays in
		// the live region where Ctrl+O can expand it. Reset tracking fires
		// here so the first post-compaction assistant turn — not a kept
		// pre-compaction one — is marked as a cache miss.
		if (options?.transcript) handleEntryResetTracking(compaction);
		if (options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		// Emit messages after compaction
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// No compaction - emit all messages, handle branch summaries and custom messages
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	// Strip dangling tool_use blocks — a tool_use with no matching tool_result on the
	// resolved leaf→root path — from ANY assistant turn, not just the trailing one.
	// This happens whenever the leaf (or a branch point) lands such that an assistant
	// turn's tool results are off the selected path: its result children live on a
	// sibling branch, or it is the leaf itself (results are children below it). Left
	// in place, `transformMessages` fabricates one synthetic "aborted"/"No result
	// provided" result per dangling call, which render as phantom failed calls and
	// re-inject the failed batch into the model's
	// context — the rewind/restore loop.
	//
	// Stripping is necessary but not sufficient: a *modified* assistant turn that still
	// carries signed `thinking`/`redacted_thinking` is rejected by Anthropic — "thinking
	// blocks in the latest assistant message cannot be modified", and signed thinking
	// replayed out of its original turn shape can also fail signature validation (this
	// bites the handoff/branch-summary request). So when we rewrite a turn we also
	// neutralize its protected reasoning: drop `redactedThinking` (encrypted, no
	// plaintext to keep) and clear `thinking` signatures so the provider encoder
	// downgrades them to plain text (verified accepted by the live API), preserving the
	// visible reasoning while removing the immutability/invalid-signature hazard. Drop a
	// turn left with no content. (Live turns only qualify mid-turn: a transcript rebuild
	// while the tool still executes sees the persisted assistant turn without its result.
	// Those callers pass `keepDanglingToolCalls` so the in-flight call stays visible as
	// a pending block instead of vanishing from the chat.)
	const keepDangling = options?.transcript === true && options.keepDanglingToolCalls === true;
	if (!keepDangling) {
		const pairedToolResultIds = new Set<string>();
		for (const message of messages) {
			if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			let strippedToolCalls = 0;
			for (const block of message.content) {
				if (block.type === "toolCall" && !pairedToolResultIds.has(block.id)) strippedToolCalls++;
			}
			if (strippedToolCalls === 0) continue;
			const normalized = message.content
				.filter(
					block =>
						!(block.type === "toolCall" && !pairedToolResultIds.has(block.id)) &&
						block.type !== "redactedThinking",
				)
				.map(block =>
					block.type === "thinking" && block.thinkingSignature
						? { ...block, thinkingSignature: undefined }
						: block,
				);
			if (normalized.length === 0 && !options?.transcript) {
				messages.splice(i, 1);
			} else {
				const rewritten = { ...message, content: normalized };
				if (options?.transcript) {
					// Display transcript: keep the turn (even content-less) and mark
					// how many calls were dropped so the TUI renders a placeholder
					// row instead of silently erasing the turn's activity.
					(rewritten as AgentMessage & StrippedToolCallsMarker).strippedToolCalls = strippedToolCalls;
				}
				messages[i] = rewritten;
			}
		}
	}

	return {
		messages,
		cacheMissExplainedAt: options?.transcript ? cacheMissExplainedAt : undefined,
		thinkingLevel,
		configuredThinkingLevel,
		serviceTier,
		models,
		injectedTtsrRules,
		mode,
		modeData,
	};
}
