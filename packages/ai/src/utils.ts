import { $env } from "@oh-my-pi/pi-utils";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { CacheRetention, OpenAIResponsesHistoryPayload, ProviderPayload } from "./types";

type OpenAIResponsesReplayItem = ResponseInput[number];

export { isRecord } from "@oh-my-pi/pi-utils";
export function normalizeSystemPrompts(systemPrompt: readonly string[] | undefined): string[] {
	return systemPrompt?.map(prompt => prompt.toWellFormed()).filter(prompt => prompt.length > 0) ?? [];
}

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

export function normalizeResponsesToolCallId(id: string): { callId: string; itemId: string } {
	const [callId, itemId] = id.split("|");
	if (callId && itemId) {
		const normalizedCallId = truncateResponseItemId(callId, getIdPrefix(callId, "call"));
		const normalizedItemId = normalizeResponsesItemId(itemId);
		return { callId: normalizedCallId, itemId: normalizedItemId };
	}
	const hash = Bun.hash(id).toString(36);
	const normalizedCallId = id.startsWith("call_") ? truncateResponseItemId(id, "call") : `call_${hash}`;
	return { callId: normalizedCallId, itemId: `fc_${hash}` };
}

function getIdPrefix(id: string, fallback: string): string {
	const prefix = id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
	return prefix || fallback;
}

function normalizeResponsesItemId(itemId: string): string {
	const prefix = getIdPrefix(itemId, "fc");
	if (prefix !== "fc" && prefix !== "fcr") {
		return `fc_${Bun.hash(itemId).toString(36)}`;
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

export function sanitizeOpenAIResponsesHistoryItemsForReplay(items: Array<Record<string, unknown>>): ResponseInput {
	const normalizedCallIds = new Map<string, string>();
	return items.flatMap(item => {
		const sanitized = sanitizeOpenAIResponsesHistoryItemForReplay(item, normalizedCallIds);
		return sanitized ? [sanitized] : [];
	});
}

function sanitizeOpenAIResponsesHistoryItemForReplay(
	item: Record<string, unknown>,
	normalizedCallIds: Map<string, string>,
): OpenAIResponsesReplayItem | undefined {
	if (item.type === "item_reference") return undefined;

	// providerPayload stores raw output items; replay strips item ids and keeps only normalized call_id.
	const { id: _id, ...sanitizedItem } = item;
	if (typeof item.call_id === "string") {
		sanitizedItem.call_id = normalizeReplayedResponsesHistoryCallId(item.call_id, normalizedCallIds);
	}

	return sanitizedItem as unknown as OpenAIResponsesReplayItem;
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
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) return cacheRetention;
	if ($env.PI_CACHE_RETENTION === "long") return "long";
	return "short";
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}
