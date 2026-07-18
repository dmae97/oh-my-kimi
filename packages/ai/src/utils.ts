import { $env } from "@oh-my-pi/pi-utils";
import type { ResponseInput, ResponseInputItem } from "./providers/openai-responses-wire";
import { redactSensitiveCredentials } from "./providers/transform-messages";
import type { CacheRetention, OpenAIResponsesHistoryPayload, ProviderPayload } from "./types";

type OpenAIResponsesReplayItem = ResponseInput[number];
const NON_WHITESPACE_RE = /\S/;

export { isRecord } from "@oh-my-pi/pi-utils";
export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): string[] {
	if (systemPrompt === undefined || systemPrompt === null) return [];
	const prompts = Array.isArray(systemPrompt) ? systemPrompt : typeof systemPrompt === "string" ? [systemPrompt] : [];
	return prompts
		.map(prompt => redactSensitiveCredentials(prompt.toWellFormed()))
		.filter(prompt => prompt.trim().length > 0);
}

export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

type ResponsesToolItemIdPrefix = "fc" | "ctc";

export function normalizeResponsesToolCallId(
	id: string,
	itemPrefix: ResponsesToolItemIdPrefix = "fc",
): { callId: string; itemId: string } {
	const [callId, itemId] = id.split("|");
	if (callId && itemId) {
		const normalizedCallId = truncateResponseItemId(callId, getIdPrefix(callId, "call"));
		const normalizedItemId = normalizeResponsesItemId(itemId, itemPrefix);
		return { callId: normalizedCallId, itemId: normalizedItemId };
	}
	const hash = Bun.hash(id).toString(36);
	const normalizedCallId = id.startsWith("call_") ? truncateResponseItemId(id, "call") : `call_${hash}`;
	return { callId: normalizedCallId, itemId: `${itemPrefix}_${hash}` };
}

function getIdPrefix(id: string, fallback: string): string {
	const prefix = id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
	return prefix || fallback;
}

function getExplicitIdPrefix(id: string): string | undefined {
	return id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
}

function normalizeResponsesItemId(itemId: string, fallbackPrefix: ResponsesToolItemIdPrefix): string {
	const prefix = getExplicitIdPrefix(itemId);
	const isAllowedPrefix = prefix
		? fallbackPrefix === "ctc"
			? prefix === "ctc"
			: prefix === "fc" || prefix === "fcr"
		: false;
	if (!prefix || !isAllowedPrefix) {
		return `${fallbackPrefix}_${Bun.hash(itemId).toString(36)}`;
	}
	return truncateResponseItemId(itemId, prefix);
}

/**
 * Truncate an OpenAI Responses API item ID to 64 characters.
 * IDs exceeding the limit are replaced with a hash-based ID using the given prefix.
 */
export function truncateResponseItemId(id: string, prefix: string): string {
	if (id.length <= 64) return id;
	return `${prefix}_${Bun.hash(id).toString(36)}`;
}

interface OpenAIResponsesReplaySanitizeOptions {
	supportsImageDetailOriginal?: boolean;
}

/**
 * Clamp `detail: "original"` only where Responses input_image parts live —
 * top-level items and `message.content[]`. Avoids a deep tree walk/clone of
 * every history node on providers that reject native-resolution images.
 */
function clampReplayItemImageDetail(
	item: Record<string, unknown>,
	supportsImageDetailOriginal: boolean,
): Record<string, unknown> {
	if (supportsImageDetailOriginal) return item;

	if (item.type === "input_image" && item.detail === "original") {
		return { ...item, detail: "auto" };
	}

	if (item.type !== "message" || !Array.isArray(item.content)) return item;

	let changed = false;
	const content = item.content.map(part => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return part;
		const record = part as Record<string, unknown>;
		if (record.type !== "input_image" || record.detail !== "original") return part;
		changed = true;
		return { ...record, detail: "auto" };
	});
	return changed ? { ...item, content } : item;
}

export function sanitizeOpenAIResponsesHistoryItemsForReplay(
	items: Array<Record<string, unknown>>,
	options: OpenAIResponsesReplaySanitizeOptions = {},
): ResponseInput {
	const normalizedCallIds = new Map<string, string>();
	const supportsImageDetailOriginal = options.supportsImageDetailOriginal !== false;
	return items.flatMap(item => {
		const sanitized = sanitizeOpenAIResponsesHistoryItemForReplay(
			item,
			normalizedCallIds,
			supportsImageDetailOriginal,
		);
		return sanitized ? [sanitized] : [];
	});
}

/**
 * Sanitize assistant-native Responses history for replay.
 *
 * Returns `undefined` for hidden-empty turns that only contain reasoning and an
 * empty assistant message, allowing callers to rebuild visible transcript
 * history instead of replaying stale native state.
 */
export function sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
	items: Array<Record<string, unknown>>,
	options: OpenAIResponsesReplaySanitizeOptions = {},
): ResponseInput | undefined {
	const sanitized = sanitizeOpenAIResponsesHistoryItemsForReplay(items, options);
	let hasReplayableAssistantOutput = false;

	for (const item of sanitized) {
		if (item.type === "reasoning") continue;
		if (item.type !== "message" || item.role !== "assistant") {
			hasReplayableAssistantOutput = true;
			break;
		}
		if (typeof item.content === "string") {
			if (NON_WHITESPACE_RE.test(item.content)) {
				hasReplayableAssistantOutput = true;
				break;
			}
			continue;
		}
		for (const part of item.content) {
			if (part.type === "output_text" && NON_WHITESPACE_RE.test(part.text)) {
				hasReplayableAssistantOutput = true;
				break;
			}
			if (part.type === "refusal" && NON_WHITESPACE_RE.test(part.refusal)) {
				hasReplayableAssistantOutput = true;
				break;
			}
		}
		if (hasReplayableAssistantOutput) break;
	}

	return hasReplayableAssistantOutput ? sanitized : undefined;
}

/**
 * Drop hidden-only fallback assistant replay after a native Responses snapshot is rejected.
 */
export function sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(items: ResponseInput): ResponseInput {
	const sanitized: ResponseInput = [];

	for (const item of items) {
		if (item.type === "reasoning") continue;
		if (item.type !== "message" || item.role !== "assistant") {
			sanitized.push(item);
			continue;
		}

		let hasVisibleText = false;
		if (typeof item.content === "string") {
			hasVisibleText = NON_WHITESPACE_RE.test(item.content);
		} else {
			for (const part of item.content) {
				if (part.type === "output_text" && NON_WHITESPACE_RE.test(part.text)) {
					hasVisibleText = true;
					break;
				}
				if (part.type === "refusal" && NON_WHITESPACE_RE.test(part.refusal)) {
					hasVisibleText = true;
					break;
				}
			}
		}

		if (hasVisibleText) sanitized.push(item);
	}

	return sanitized;
}

function sanitizeOpenAIResponsesHistoryItemForReplay(
	item: Record<string, unknown>,
	normalizedCallIds: Map<string, string>,
	supportsImageDetailOriginal: boolean,
): OpenAIResponsesReplayItem | undefined {
	if (item.type === "item_reference") return undefined;
	if (item.type === "image_generation_call") return sanitizeOpenAIResponsesImageGenerationCallForReplay(item);
	if (item.type === "reasoning") return sanitizeOpenAIResponsesReasoningItemForReplay(item);

	// providerPayload stores raw output items; replay strips item ids and keeps only normalized call_id.
	const { id: _id, ...sanitizedItem } = item;
	if (typeof item.call_id === "string") {
		sanitizedItem.call_id = normalizeReplayedResponsesHistoryCallId(item.call_id, normalizedCallIds);
	}

	return clampReplayItemImageDetail(
		sanitizedItem,
		supportsImageDetailOriginal,
	) as unknown as OpenAIResponsesReplayItem;
}

function sanitizeOpenAIResponsesReasoningItemForReplay(item: Record<string, unknown>): OpenAIResponsesReplayItem {
	const sanitizedItem: Record<string, unknown> = { type: "reasoning" };
	if (Array.isArray(item.summary)) sanitizedItem.summary = item.summary;
	if (Array.isArray(item.content)) sanitizedItem.content = item.content;
	if (typeof item.encrypted_content === "string" || item.encrypted_content === null) {
		sanitizedItem.encrypted_content = item.encrypted_content;
	}
	if (item.status === "in_progress" || item.status === "completed" || item.status === "incomplete") {
		sanitizedItem.status = item.status;
	}
	return sanitizedItem as unknown as OpenAIResponsesReplayItem;
}

function sanitizeOpenAIResponsesImageGenerationCallForReplay(
	item: Record<string, unknown>,
): ResponseInputItem.ImageGenerationCall | undefined {
	if (typeof item.id !== "string" || item.status !== "completed" || typeof item.result !== "string") {
		return undefined;
	}
	return {
		id: truncateResponseItemId(item.id, "ig"),
		type: "image_generation_call",
		status: "completed",
		result: item.result,
	};
}

function normalizeReplayedResponsesHistoryCallId(value: string, normalizedValues: Map<string, string>): string {
	const normalized = normalizedValues.get(value);
	if (normalized) return normalized;
	const next = truncateResponseItemId(value, getIdPrefix(value, "call"));
	normalizedValues.set(value, next);
	return next;
}

export function createOpenAIResponsesHistoryPayload(
	provider: string,
	items: Array<Record<string, unknown>>,
	incremental = true,
): OpenAIResponsesHistoryPayload {
	return {
		type: "openaiResponsesHistory",
		provider,
		...(incremental ? { dt: true } : {}),
		items,
	};
}

export function getOpenAIResponsesHistoryPayload(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): OpenAIResponsesHistoryPayload | undefined {
	if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
		return undefined;
	}
	const payloadProvider = providerPayload.provider ?? fallbackProvider;
	if (!payloadProvider || payloadProvider !== currentProvider) {
		return undefined;
	}
	return { ...providerPayload, provider: payloadProvider };
}

export function getOpenAIResponsesHistoryItems(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): Array<Record<string, unknown>> | undefined {
	return getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider)?.items;
}

/**
 * Resolve cache retention preference: explicit request option first, then the
 * `PI_CACHE_RETENTION` env override (`long` | `short` | `none`), then the
 * provider-supplied fallback.
 */
export function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	fallback: CacheRetention = "short",
): CacheRetention {
	if (cacheRetention) return cacheRetention;
	const env = $env.PI_CACHE_RETENTION;
	if (env === "long" || env === "short" || env === "none") return env;
	return fallback;
}
