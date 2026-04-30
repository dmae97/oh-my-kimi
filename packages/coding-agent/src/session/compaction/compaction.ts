/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	completeSimple,
	Effort,
	type MessageAttribution,
	type Model,
	type Usage,
} from "@oh-my-pi/pi-ai";
import {
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-ai/providers/openai-codex/constants";
import { parseTextSignature } from "@oh-my-pi/pi-ai/providers/openai-responses-shared";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
} from "@oh-my-pi/pi-ai/utils";
import { countTokens } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import compactionShortSummaryPrompt from "../../prompts/compaction/compaction-short-summary.md" with { type: "text" };
import compactionSummaryPrompt from "../../prompts/compaction/compaction-summary.md" with { type: "text" };
import compactionTurnPrefixPrompt from "../../prompts/compaction/compaction-turn-prefix.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "../../prompts/compaction/compaction-update-summary.md" with { type: "text" };
import { convertToLlm, createBranchSummaryMessage, createCustomMessage } from "../../session/messages";
import type { CompactionEntry, SessionEntry } from "../../session/session-manager";

import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
	upsertFileOperations,
} from "./utils";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.attribution,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	/** Short PR-style summary for display purposes. */
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Hook-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist alongside compaction entry. */
	preserveData?: Record<string, unknown>;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "context-full" | "handoff" | "off";
	thresholdPercent?: number;
	thresholdTokens?: number;
	reserveTokens: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEnabled?: boolean;
	remoteEndpoint?: string;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1,
	thresholdTokens: -1,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	autoContinue: true,
	remoteEnabled: true,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function calculatePromptTokens(usage: Usage): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/**
 * Effective reserve: at least 15% of context window or the configured floor, whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens);
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	// Fixed token limit takes priority over percentage
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		// Clamp to [1, contextWindow - 1] so there's always room
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}

	// Percentage-based threshold
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return contextWindow - effectiveReserveTokens(contextWindow, settings);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Estimate token count for a message using cl100k_base via the native
 * tokenizer. This is not Claude's first-party tokenizer (Anthropic doesn't
 * publish one) but is within ~5–10% across English/code text.
 */
export function estimateTokens(message: AgentMessage): number {
	const fragments: string[] = [];
	let extra = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				fragments.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					}
				}
			}
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					fragments.push(block.text);
				} else if (block.type === "thinking") {
					fragments.push(block.thinking);
				} else if (block.type === "toolCall") {
					fragments.push(block.name);
					fragments.push(JSON.stringify(block.arguments));
				}
			}
			break;
		}
		case "hookMessage":
		case "toolResult": {
			if (typeof message.content === "string") {
				fragments.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "bashExecution": {
			fragments.push(message.command);
			fragments.push(message.output);
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			fragments.push(message.summary);
			break;
		}
		default:
			return 0;
	}

	if (fragments.length === 0) return extra;
	return extra + countTokens(fragments);
}

function estimateEntriesTokens(entries: SessionEntry[], startIndex: number, endIndex: number): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i]);
		if (msg) {
			total += estimateTokens(msg);
		}
	}
	return total;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
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
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
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

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = prompt.render(compactionSummaryPrompt);

const UPDATE_SUMMARIZATION_PROMPT = prompt.render(compactionUpdateSummaryPrompt);

const SHORT_SUMMARY_PROMPT = prompt.render(compactionShortSummaryPrompt);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";

type OpenAiRemoteCompactionItem = {
	type: "compaction" | "compaction_summary";
	encrypted_content?: string;
	summary?: string;
};

interface OpenAiRemoteCompactionPreserveData {
	provider?: string;
	replacementHistory: Array<Record<string, unknown>>;
	compactionItem: OpenAiRemoteCompactionItem;
}

interface OpenAiRemoteCompactionRequest {
	model: string;
	input: Array<Record<string, unknown>>;
	instructions: string;
}

interface OpenAiRemoteCompactionResponse extends OpenAiRemoteCompactionPreserveData {}

interface RemoteCompactionResponse {
	summary: string;
	shortSummary?: string;
}

function shouldUseOpenAiRemoteCompaction(model: Model): boolean {
	return model.provider === "openai" || model.provider === "openai-codex";
}

function resolveOpenAiCompactEndpoint(model: Model): string {
	if (model.provider === "openai-codex") {
		return resolveOpenAiCodexCompactEndpoint(model.baseUrl);
	}

	const defaultBase = "https://api.openai.com/v1";
	const rawBase = model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : defaultBase;
	const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
	if (normalizedBase.endsWith("/v1")) return `${normalizedBase}/responses/compact`;
	return `${normalizedBase}/v1/responses/compact`;
}

function resolveOpenAiCodexCompactEndpoint(baseUrl: string | undefined): string {
	const rawBase = baseUrl && baseUrl.length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
	if (/\/codex(?:\/v\d+)?$/.test(normalizedBase)) return `${normalizedBase}/responses/compact`;
	return `${normalizedBase}/codex/responses/compact`;
}

function normalizeOpenAiCompactionToolCallId(id: string): string {
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId ?? normalized.callId}`;
}

function getPreservedOpenAiRemoteCompactionData(
	preserveData: Record<string, unknown> | undefined,
): OpenAiRemoteCompactionPreserveData | undefined {
	const candidate = preserveData?.[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const maybeData = candidate as { provider?: unknown; replacementHistory?: unknown; compactionItem?: unknown };
	if (!Array.isArray(maybeData.replacementHistory)) return undefined;
	const maybeItem = maybeData.compactionItem;
	if (!maybeItem || typeof maybeItem !== "object") return undefined;
	const compactionItem = maybeItem as { type?: unknown; encrypted_content?: unknown; summary?: unknown };
	const isClassicCompaction =
		compactionItem.type === "compaction" && typeof compactionItem.encrypted_content === "string";
	const isSummaryCompaction = compactionItem.type === "compaction_summary";
	if (!isClassicCompaction && !isSummaryCompaction) {
		return undefined;
	}
	return {
		provider: typeof maybeData.provider === "string" ? maybeData.provider : undefined,
		replacementHistory: maybeData.replacementHistory as Array<Record<string, unknown>>,
		compactionItem: compactionItem as unknown as OpenAiRemoteCompactionItem,
	};
}

function withOpenAiRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	remoteCompaction: OpenAiRemoteCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
	if (remoteCompaction) {
		return {
			...(preserveData ?? {}),
			[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: remoteCompaction,
		};
	}

	if (!preserveData || !(OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}

	const { [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

function estimateOpenAiCompactInputTokens(input: Array<Record<string, unknown>>, instructions: string): number {
	let chars = instructions.length;
	for (const item of input) {
		chars += JSON.stringify(item).length;
	}
	return Math.ceil(chars / 4);
}

function shouldTrimOpenAiCompactInputItem(item: Record<string, unknown>): boolean {
	return item.type === "function_call_output" || (item.type === "message" && item.role === "developer");
}

function shouldKeepOpenAiCompactOutputUserMessage(item: Record<string, unknown>): boolean {
	if (item.role !== "user") return false;
	const content = item.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	const contextualFragmentPatterns = [
		[/^<system-reminder>[\s\S]*<\/system-reminder>$/i, /<system-reminder>/i],
		[/^#\s*AGENTS\.md instructions for\b[\s\S]*<\/INSTRUCTIONS>$/i, /# AGENTS.md instructions/],
		[/^<environment-context>[\s\S]*<\/environment-context>$/i, /<environment-context>/i],
		[/^<skill>[\s\S]*<\/skill>$/i, /<skill>/i],
		[/^<user-shell-command>[\s\S]*<\/user-shell-command>$/i, /<user-shell-command>/i],
		[/^<turn-aborted>[\s\S]*<\/turn-aborted>$/i, /<turn-aborted>/i],
		[/^<subagent-notification>[\s\S]*<\/subagent-notification>$/i, /<subagent-notification>/i],
	] as const;
	return content.every(part => {
		if (!part || typeof part !== "object") return false;
		const candidate = part as { type?: unknown; text?: unknown };
		if (candidate.type === "input_image") return true;
		if (candidate.type !== "input_text" || typeof candidate.text !== "string") return false;
		const trimmed = candidate.text.trim();
		if (trimmed.length === 0) return false;
		return !contextualFragmentPatterns.some(([strictPattern, markerPattern]) => {
			return strictPattern.test(trimmed) || markerPattern.test(trimmed);
		});
	});
}

function shouldKeepOpenAiCompactOutputItem(item: Record<string, unknown>): boolean {
	if (item.type === "compaction" || item.type === "compaction_summary") return true;
	if (item.type !== "message") return false;
	if (item.role === "developer") return false;
	if (item.role === "assistant") return true;
	return shouldKeepOpenAiCompactOutputUserMessage(item);
}

function trimOpenAiCompactInput(
	input: Array<Record<string, unknown>>,
	contextWindow: number,
	instructions: string,
): Array<Record<string, unknown>> {
	const trimmed = [...input];
	while (trimmed.length > 0 && estimateOpenAiCompactInputTokens(trimmed, instructions) > contextWindow) {
		const last = trimmed[trimmed.length - 1];
		if (last?.type === "function_call_output") {
			const callId = typeof last.call_id === "string" ? last.call_id : undefined;
			trimmed.pop();
			if (callId) {
				const matchingCallIndex = trimmed.findLastIndex(
					item => item.type === "function_call" && item.call_id === callId,
				);
				if (matchingCallIndex >= 0) {
					trimmed.splice(matchingCallIndex, 1);
				}
			}
			continue;
		}
		if (!last || !shouldTrimOpenAiCompactInputItem(last)) {
			break;
		}
		trimmed.pop();
	}
	return trimmed;
}

function collectKnownOpenAiCallIds(items: Array<Record<string, unknown>>): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of items) {
		if (item.type === "function_call" && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		}
	}
	return knownCallIds;
}

function buildOpenAiNativeHistory(
	messages: AgentMessage[],
	model: Model,
	previousReplacementHistory?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const input: Array<Record<string, unknown>> = previousReplacementHistory ? [...previousReplacementHistory] : [];
	const transformedMessages = transformMessages(convertToLlm(messages), model, id =>
		normalizeOpenAiCompactionToolCallId(id),
	);

	let msgIndex = 0;
	let knownCallIds = collectKnownOpenAiCallIds(input);
	for (const message of transformedMessages) {
		if (message.role === "user" || message.role === "developer") {
			const providerPayload = (message as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			if (historyItems) {
				input.push(...historyItems);
				knownCallIds = collectKnownOpenAiCallIds(input);
				msgIndex++;
				continue;
			}

			const contentBlocks: Array<Record<string, unknown>> = [];
			if (typeof message.content === "string") {
				if (message.content.trim().length > 0) {
					contentBlocks.push({ type: "input_text", text: message.content.toWellFormed() });
				}
			} else {
				for (const block of message.content) {
					if (block.type === "text") {
						if (!block.text || block.text.trim().length === 0) continue;
						contentBlocks.push({ type: "input_text", text: block.text.toWellFormed() });
						continue;
					}
					if (block.type === "image") {
						contentBlocks.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}
			}
			if (contentBlocks.length > 0) {
				input.push({ type: "message", role: message.role, content: contentBlocks });
			}
			msgIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const providerPayload = getOpenAIResponsesHistoryPayload(
				assistant.providerPayload,
				model.provider,
				assistant.provider,
			);
			if (providerPayload) {
				if (providerPayload.dt) {
					input.push(...providerPayload.items);
				} else {
					input.splice(0, input.length, ...providerPayload.items);
				}
				knownCallIds = collectKnownOpenAiCallIds(input);
				msgIndex++;
				continue;
			}
			const isDifferentModel =
				assistant.model !== model.id && assistant.provider === model.provider && assistant.api === model.api;

			for (const block of assistant.content) {
				if (block.type === "thinking" && assistant.stopReason !== "error" && block.thinkingSignature) {
					try {
						const reasoningItem = JSON.parse(block.thinkingSignature) as Record<string, unknown>;
						if (reasoningItem && typeof reasoningItem === "object") {
							input.push(reasoningItem);
						}
					} catch {
						logger.warn("Failed to parse assistant reasoning for remote compaction", {
							model: assistant.model,
							provider: assistant.provider,
						});
					}
					continue;
				}

				if (block.type === "text") {
					if (!block.text || block.text.trim().length === 0) continue;
					const parsedSignature = parseTextSignature(block.textSignature);
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${Bun.hash(msgId).toString(36)}`;
					}
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					});
					continue;
				}

				if (block.type === "toolCall") {
					const normalized = normalizeResponsesToolCallId(block.id);
					let itemId: string | undefined = normalized.itemId;
					if (isDifferentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("fcr_"))) {
						itemId = undefined;
					}
					knownCallIds.add(normalized.callId);
					input.push({
						type: "function_call",
						id: itemId,
						call_id: normalized.callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}

			msgIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			const normalized = normalizeResponsesToolCallId(message.toolCallId);
			if (!knownCallIds.has(normalized.callId)) {
				msgIndex++;
				continue;
			}

			const textOutput = message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const hasImages = message.content.some(block => block.type === "image");
			input.push({
				type: "function_call_output",
				call_id: normalized.callId,
				output: (textOutput.length > 0 ? textOutput : "(see attached image)").toWellFormed(),
			});

			if (hasImages && model.input.includes("image")) {
				const contentBlocks: Array<Record<string, unknown>> = [
					{ type: "input_text", text: "Attached image(s) from tool result:" },
				];
				for (const block of message.content) {
					if (block.type !== "image") continue;
					contentBlocks.push({
						type: "input_image",
						detail: "auto",
						image_url: `data:${block.mimeType};base64,${block.data}`,
					});
				}
				input.push({ type: "message", role: "user", content: contentBlocks });
			}
		}

		msgIndex++;
	}

	return input;
}

async function requestOpenAiRemoteCompaction(
	model: Model,
	apiKey: string,
	compactInput: Array<Record<string, unknown>>,
	instructions: string,
): Promise<OpenAiRemoteCompactionResponse> {
	const endpoint = resolveOpenAiCompactEndpoint(model);
	const request: OpenAiRemoteCompactionRequest = {
		model: model.id,
		input: trimOpenAiCompactInput(compactInput, model.contextWindow, instructions),
		instructions,
	};
	const headers: Record<string, string> = {
		"content-type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...(model.headers ?? {}),
	};

	// Codex endpoints require additional auth headers
	if (model.provider === "openai-codex") {
		const accountId = getCodexAccountId(apiKey);
		if (accountId) {
			headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
		}
		headers[OPENAI_HEADERS.BETA] = OPENAI_HEADER_VALUES.BETA_RESPONSES;
		headers[OPENAI_HEADERS.ORIGINATOR] = OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(request),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		logger.warn("OpenAI remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText,
		});
		throw new Error(`Remote compaction failed (${response.status} ${response.statusText})`);
	}

	const data = (await response.json()) as { output?: unknown[] } | undefined;
	const rawOutput = data?.output ?? [];
	const replacementHistory = rawOutput.filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === "object" && shouldKeepOpenAiCompactOutputItem(item as Record<string, unknown>),
	);
	const compactionItem = [...replacementHistory].reverse().find((item): item is OpenAiRemoteCompactionItem => {
		if (item.type === "compaction" && typeof item.encrypted_content === "string") return true;
		if (item.type === "compaction_summary") return true;
		return false;
	});
	if (!compactionItem) {
		const outputTypes = rawOutput.map(item =>
			typeof item === "object" && item !== null ? (item as Record<string, unknown>).type : typeof item,
		);
		logger.warn("Remote compaction response missing compaction item", {
			endpoint,
			model: model.id,
			provider: model.provider,
			rawOutputLength: rawOutput.length,
			outputTypes,
			replacementHistoryLength: replacementHistory.length,
		});
		throw new Error("Remote compaction response missing compaction item");
	}
	return { provider: model.provider, replacementHistory, compactionItem };
}

interface RemoteCompactionRequest {
	systemPrompt: string;
	prompt: string;
}

async function requestRemoteCompaction(
	endpoint: string,
	request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		logger.warn("Remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText,
		});
		throw new Error(`Remote compaction failed (${response.status} ${response.statusText})`);
	}

	const data = (await response.json()) as RemoteCompactionResponse | undefined;
	if (!data || typeof data.summary !== "string") {
		throw new Error("Remote compaction response missing summary");
	}

	return data;
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	remoteInstructions?: string;
	initiatorOverride?: MessageAttribution;
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.floor(0.8 * reserveTokens);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, hookMessage, etc.)
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	if (options?.remoteEndpoint) {
		const remote = await requestRemoteCompaction(options.remoteEndpoint, {
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			prompt: promptText,
		});
		return remote.summary;
	}

	const response = await completeSimple(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ maxTokens, signal, apiKey, reasoning: Effort.High, initiatorOverride: options?.initiatorOverride },
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	return textContent;
}

async function generateShortSummary(
	recentMessages: AgentMessage[],
	historySummary: string | undefined,
	model: Model,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(512, Math.floor(0.2 * reserveTokens));
	const llmMessages = convertToLlm(recentMessages);
	const conversationText = serializeConversation(llmMessages);

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (historySummary) {
		promptText += `<previous-summary>\n${historySummary}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += SHORT_SUMMARY_PROMPT;

	if (options?.remoteEndpoint) {
		const remote = await requestRemoteCompaction(options.remoteEndpoint, {
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			prompt: promptText,
		});
		return remote.summary;
	}

	const response = await completeSimple(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
		},
		{ maxTokens, signal, apiKey, reasoning: Effort.High, initiatorOverride: options?.initiatorOverride },
	);

	if (response.stopReason === "error") {
		throw new Error(`Short summary failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

// ============================================================================
// Compaction Preparation (for hooks)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Messages kept in full after compaction (recent history) */
	recentMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, boundaryStart, boundaryEnd);
		const promptTokens = calculatePromptTokens(lastUsage);
		const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens);

	// Get ID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Messages kept after compaction (recent history)
	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) recentMessages.push(msg);
	}
	// Nothing to summarize means compaction would be a no-op.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// Get previous summary and preserved data for iterative updates
	let previousSummary: string | undefined;
	let previousPreserveData: Record<string, unknown> | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousPreserveData = prevCompaction.preserveData;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(compactionTurnPrefixPrompt);

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds id/parentId when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: string,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEnabled === false ? undefined : settings.remoteEndpoint,
		remoteInstructions: options?.remoteInstructions,
		initiatorOverride: options?.initiatorOverride,
	};

	let preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, undefined);
	if (settings.remoteEnabled !== false && shouldUseOpenAiRemoteCompaction(model)) {
		const previousRemoteCompaction = getPreservedOpenAiRemoteCompactionData(previousPreserveData);
		const remoteMessages = [...messagesToSummarize, ...turnPrefixMessages, ...recentMessages];
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: undefined;
		const remoteHistory = buildOpenAiNativeHistory(remoteMessages, model, previousReplacementHistory);
		if (remoteHistory.length > 0) {
			try {
				const remote = await requestOpenAiRemoteCompaction(
					model,
					apiKey,
					remoteHistory,
					summaryOptions.remoteInstructions ?? SUMMARIZATION_SYSTEM_PROMPT,
				);
				preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, remote);
			} catch (err) {
				logger.warn("OpenAI remote compaction failed, falling back to local summarization", {
					error: err instanceof Error ? err.message : String(err),
					model: model.id,
					provider: model.provider,
				});
			}
		}
	}

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummary,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				signal,
				summaryOptions.initiatorOverride,
			),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		// Generate history summary from messages to summarize
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummary,
			summaryOptions,
		);
	} else if (previousSummary) {
		// No new messages to summarize, preserve previous summary
		summary = previousSummary;
	} else {
		// No messages and no previous summary
		summary = "No prior history.";
	}

	const shortSummary = await generateShortSummary(
		recentMessages,
		summary,
		model,
		settings.reserveTokens,
		apiKey,
		signal,
		{
			extraContext: options?.extraContext,
			remoteEndpoint: summaryOptions.remoteEndpoint,
			initiatorOverride: summaryOptions.initiatorOverride,
		},
	);

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	return {
		summary,
		shortSummary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
	initiatorOverride?: MessageAttribution,
): Promise<string> {
	const maxTokens = Math.floor(0.5 * reserveTokens); // Smaller budget for turn prefix

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
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
		{ maxTokens, signal, apiKey, reasoning: Effort.High, initiatorOverride },
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
