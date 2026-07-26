import type { AssistantMessage, ImageContent, Message, Model, TextContent, Usage } from "omk-ai";
import { completeSimple } from "omk-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext } from "../session/session.ts";
import { type CompactionEntry, CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionTreeEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content as string | (TextContent | ImageContent)[],
			entry.display,
			entry.details,
			entry.timestamp,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
	/** Maximum fraction of the context window to use before compaction. Default: 0.9. */
	maxUsageRatio?: number;
}

/** Default context-window ratio used before compaction triggers. */
export const DEFAULT_COMPACTION_MAX_USAGE_RATIO = 0.9;

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	maxUsageRatio: DEFAULT_COMPACTION_MAX_USAGE_RATIO,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/** Return usage from the last successful assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Estimate context tokens after adding messages that have not been sent yet. */
export function estimateProjectedContextTokens(
	messages: AgentMessage[],
	pendingMessages: AgentMessage[],
): ContextUsageEstimate {
	return estimateContextTokens([...messages, ...pendingMessages]);
}

export type CompactionHeadroomLimit = "max_usage_ratio" | "reserve_tokens";

/** Threshold calculation details for automatic compaction. */
export interface CompactionHeadroomThreshold {
	/** Context-token count that triggers compaction. */
	triggerTokens: number;
	/** Tokens kept free at the trigger point. */
	headroomTokens: number;
	/** Boundary derived from the configured max usage ratio. */
	maxUsageRatioTokens: number;
	/** Boundary derived from the absolute reserve token setting. */
	reserveBoundaryTokens: number;
	/** Which boundary triggered earlier. */
	limitedBy: CompactionHeadroomLimit;
}

/** Return the earliest compaction threshold from ratio-based headroom and absolute reserve. */
export function getCompactionHeadroomThreshold(
	contextWindow: number,
	settings: CompactionSettings,
): CompactionHeadroomThreshold | undefined {
	if (!settings.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return undefined;
	}

	const windowTokens = Math.floor(contextWindow);
	const reserveTokens = Number.isFinite(settings.reserveTokens) ? Math.max(0, Math.floor(settings.reserveTokens)) : 0;
	const configuredMaxUsageRatio = settings.maxUsageRatio ?? DEFAULT_COMPACTION_MAX_USAGE_RATIO;
	const maxUsageRatio =
		Number.isFinite(configuredMaxUsageRatio) && configuredMaxUsageRatio > 0 && configuredMaxUsageRatio < 1
			? configuredMaxUsageRatio
			: DEFAULT_COMPACTION_MAX_USAGE_RATIO;
	const maxUsageRatioTokens = Math.max(1, Math.floor(windowTokens * maxUsageRatio));
	const reserveBoundaryTokens =
		reserveTokens >= windowTokens ? maxUsageRatioTokens : Math.max(1, windowTokens - reserveTokens);
	const triggerTokens = Math.min(maxUsageRatioTokens, reserveBoundaryTokens);

	return {
		triggerTokens,
		headroomTokens: windowTokens - triggerTokens,
		maxUsageRatioTokens,
		reserveBoundaryTokens,
		limitedBy: reserveBoundaryTokens <= maxUsageRatioTokens ? "reserve_tokens" : "max_usage_ratio",
	};
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	const threshold = getCompactionHeadroomThreshold(contextWindow, settings);
	return threshold !== undefined && Number.isFinite(contextTokens) && contextTokens >= threshold.triggerTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;
const ESTIMATED_MESSAGE_OVERHEAD_TOKENS = 4;
const ESTIMATED_UNKNOWN_MESSAGE_TOKENS = 4;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return ESTIMATED_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return ESTIMATED_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return ESTIMATED_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return ESTIMATED_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return ESTIMATED_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / 4);
		}
	}

	// Invariant: this estimate is always >= the old estimate for every message,
	// so compaction can only trigger earlier, never later; this conservative
	// floor aligns with the compact-before-context-headroom-overflow fix.
	return ESTIMATED_UNKNOWN_MESSAGE_TOKENS;
}
function findValidCutPoints(entries: SessionTreeEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "active_tools_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
			case "leaf":
				break;
		}
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: SessionTreeEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: SessionTreeEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
): Promise<Result<string, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversationBounded(llmMessages, model, maxTokens);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
			: { maxTokens, signal, apiKey, headers };

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return ok(textContent);
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Messages summarized into the history summary. */
	messagesToSummarize: AgentMessage[];
	/** Prefix messages summarized separately when compaction splits a turn. */
	turnPrefixMessages: AgentMessage[];
	/** Whether compaction splits a turn. */
	isSplitTurn: boolean;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Previous compaction summary used for iterative updates. */
	previousSummary?: string;
	/** File operations extracted from summarized history. */
	fileOps: FileOperations;
	/** Settings used to prepare compaction. */
	settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: SessionTreeEntry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const dropsHistoryEntries = cutPoint.firstKeptEntryIndex > boundaryStart;
	const summarizesSplitTurnPrefix = cutPoint.isSplitTurn && cutPoint.firstKeptEntryIndex > cutPoint.turnStartIndex;
	// Invariant: normal compactions that drop at least one entry, or summarize a
	// split-turn prefix, are unchanged. Only true no-ops are skipped.
	if (!dropsHistoryEntries && !summarizesSplitTurnPrefix) {
		return ok(undefined);
	}

	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.ts";

/**
 * Rough chars-per-token estimate for bounding summarization input.
 * Conservative on purpose: serialized code/JSON runs below 4 chars/token.
 */
const SUMMARY_CHARS_PER_TOKEN = 3.5;
/**
 * Headroom subtracted on top of the output reserve: the summarization system
 * prompt, the <conversation>/prompt wrapper, and tokenizer drift between the
 * chars-per-token estimate and the real tokenizer.
 */
const SUMMARY_INPUT_SAFETY_TOKENS = 2048;

function summaryElisionMessage(omittedCount: number): Message {
	return {
		role: "user",
		content: `[... ${omittedCount} earlier message(s) omitted to fit the summarization context window ...]`,
		timestamp: Date.now(),
	} as Message;
}

/**
 * Serialize a conversation for summarization, bounded to the model's context
 * window. When the full serialization would exceed the window, middle
 * messages are dropped (keeping the goal-bearing head and the recent-work
 * tail) with an explicit elision marker; oversized single messages fall back
 * to hard text truncation keeping both ends.
 *
 * Without this bound, a session that already overflows the model cannot be
 * compacted: the summarization request itself exceeds the window, the
 * provider rejects it (e.g. Codex context_length_exceeded), and overflow
 * recovery is stuck permanently.
 */
export function serializeConversationBounded(messages: Message[], model: Model<any>, maxOutputTokens: number): string {
	const serialized = serializeConversation(messages);
	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return serialized;
	const budgetTokens = contextWindow - maxOutputTokens - SUMMARY_INPUT_SAFETY_TOKENS;
	const budgetChars = Math.floor(Math.max(0, budgetTokens) * SUMMARY_CHARS_PER_TOKEN);
	if (serialized.length <= budgetChars) return serialized;
	// Window too small to bound meaningfully; leave it to the provider error path.
	if (budgetChars < 4096) return serialized;

	// Halve the kept head/tail spans until the elided conversation fits.
	for (let keep = Math.floor(messages.length / 2); keep >= 1; keep = Math.floor(keep / 2)) {
		const head = messages.slice(0, keep);
		const tail = messages.slice(messages.length - keep);
		const omitted = messages.length - head.length - tail.length;
		if (omitted <= 0) continue;
		const bounded = serializeConversation([...head, summaryElisionMessage(omitted), ...tail]);
		if (bounded.length <= budgetChars) return bounded;
	}

	// Single oversized message(s): truncate the text itself, keeping both ends.
	const headChars = Math.floor(budgetChars / 2);
	const tailChars = Math.max(0, budgetChars - headChars - 128);
	return `${serialized.slice(0, headChars)}\n[... middle omitted to fit the summarization context window ...]\n${serialized.slice(serialized.length - tailChars)}`;
}

/** Generate compaction summary data from prepared session history. */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<Result<CompactionResult, CompactionError>> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	if (!firstKeptEntryId) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}

	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
					)
				: Promise.resolve(ok<string, CompactionError>("No prior history.")),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
			),
		]);
		if (!historyResult.ok) return err(historyResult.error);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
	} else {
		const summaryResult = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value;
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	});
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<Result<string, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversationBounded(llmMessages, model, maxTokens);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
			: { maxTokens, signal, apiKey, headers },
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	return ok(
		response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n"),
	);
}
