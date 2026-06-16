import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
	resolveServiceTier,
	type ServiceTier,
	type StopReason,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type TextSignatureV1,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
} from "../types";
import { normalizeResponsesToolCallId } from "../utils";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { parseStreamingJson, parseStreamingJsonThrottled } from "../utils/json-parse";
import type {
	ResponseCreateParamsStreaming,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";
export const OPENAI_RESPONSES_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.created",
	"response.output_item.added",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.content_part.added",
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.custom_tool_call_input.delta",
	"response.custom_tool_call_input.done",
	"response.output_item.done",
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

export function isOpenAIResponsesProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has(type);
}

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type === "function_call" && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		} else if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			knownCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return knownCallIds;
}

/** Scan replay items for call_ids that were originally custom tool calls. */
export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			customCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return customCallIds;
}

/**
 * Convert orphan `function_call_output` / `custom_tool_call_output` items —
 * those whose `call_id` has no matching preceding `function_call` /
 * `custom_tool_call` in the same input — into assistant text notes.
 *
 * The Responses API rejects unpaired outputs with
 * `400 No tool call found for function call output with call_id …`. Orphans
 * sneak in through two paths today:
 *
 * - A previous turn's `providerPayload` snapshot replaces the input array via
 *   the `dt: false` splice (see {@link convertConversationMessages}), wiping
 *   the matching `function_call` while leaving the matching
 *   `function_call_output` queued in a later `toolResult`.
 * - A locally-rejected tool call (argument-validation failure, hook reject,
 *   aborted turn before the call streamed) produces a tool result without a
 *   `function_call` ever landing in any persisted provider payload.
 *
 * Dropping the result loses information the model needs to recover; sending
 * it as-is 400s the request. Folding it into an assistant `message` preserves
 * the payload (call_id + truncated output) while staying within the Responses
 * input grammar. Matches the behavior of {@link transformRequestBody} in the
 * codex provider — issue #1351 / regression of #472.
 */
export function repairOrphanResponsesToolOutputs(input: ResponseInput): ResponseInput {
	const knownCallIds = new Set<string>();
	for (const item of input) {
		const t = (item as { type?: string }).type;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId !== "string") continue;
		if (t === "function_call" || t === "custom_tool_call") knownCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string" && !knownCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	return input.map(item => {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") return item;
		const record = item as { call_id?: unknown; output?: unknown; name?: unknown };
		const callId = record.call_id;
		if (typeof callId !== "string" || knownCallIds.has(callId)) return item;
		const toolName = typeof record.name === "string" && record.name.length > 0 ? record.name : "tool";
		const rawOutput = record.output;
		let text: string;
		if (typeof rawOutput === "string") text = rawOutput;
		else if (rawOutput == null) text = "";
		else {
			try {
				text = JSON.stringify(rawOutput);
			} catch {
				text = String(rawOutput);
			}
		}
		const ORPHAN_OUTPUT_LIMIT = 16_000;
		if (text.length > ORPHAN_OUTPUT_LIMIT) text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
		return {
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolName} result; call_id=${callId}]: ${text}`,
		} as ResponseInput[number];
	});
}

/** Placeholder output for a tool call whose result is absent from the input. */
const ORPHAN_TOOL_CALL_PLACEHOLDER =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

/**
 * Synthesize a placeholder `function_call_output` / `custom_tool_call_output`
 * for every `function_call` / `custom_tool_call` whose `call_id` has no matching
 * output later in the same input. The Responses API rejects an unpaired call
 * with `400 No tool output found for function call …`.
 *
 * Orphan calls surface when the user branches/navigates the session tree to a
 * node that ends on a tool call (the tool-result child is excluded from the
 * reconstructed history) or when a turn is aborted/crashes after the call
 * streamed but before its result persisted. Dropping the call would erase the
 * assistant's action; a placeholder output keeps the call visible so the model
 * can recover (e.g. re-issue the call). Symmetric to
 * {@link repairOrphanResponsesToolOutputs}.
 */
export function repairOrphanResponsesToolCalls(input: ResponseInput): ResponseInput {
	const outputCallIds = new Set<string>();
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string") outputCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call" && t !== "custom_tool_call") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string" && !outputCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	const repaired: ResponseInput = [];
	for (const item of input) {
		repaired.push(item);
		const t = (item as { type?: string }).type;
		if (t !== "function_call" && t !== "custom_tool_call") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId !== "string" || outputCallIds.has(callId)) continue;
		repaired.push({
			type: t === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			call_id: callId,
			output: ORPHAN_TOOL_CALL_PLACEHOLDER,
		} as ResponseInput[number]);
	}
	return repaired;
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		return [{ type: "input_text", text: content.toWellFormed() } satisfies ResponseInputText];
	}

	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const text = item.text.toWellFormed();
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push({
			type: "input_image",
			detail: item.detail ?? "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage);
	}
	if (omittedImages) {
		normalizedContent.push({
			type: "input_text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
): ResponseInput {
	const outputItems: ResponseInput = [];
	let unsignedTextBlocks = 0;
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (!includeThinkingSignatures) {
				continue;
			}
			if (block.thinkingSignature) {
				try {
					outputItems.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
				} catch {
					// Legacy/corrupt persisted signature — skip the reasoning item
					// rather than failing the whole request build.
				}
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				// Distinct ids per unsigned block: several text blocks in one message
				// (cross-provider replay downgrades thinking → text) must not share an id.
				msgId = unsignedTextBlocks === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${unsignedTextBlocks}`;
				unsignedTextBlocks += 1;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			outputItems.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				id: msgId,
				phase: parsedSignature?.phase,
			} satisfies ResponseOutputMessage);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
		let itemId: string | undefined = normalized.itemId;
		if (isDifferentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				id: itemId,
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		outputItems.push({
			type: "function_call",
			id: itemId,
			call_id: normalized.callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return outputItems;
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
): void {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	const output = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: "(see attached image)"
	).toWellFormed();
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		// Strict backends (Azure, Copilot) reject unpaired outputs outright, but
		// silently dropping the result loses information the model needs. Fold it
		// into an assistant note instead (same shape as repairOrphanResponsesToolOutputs).
		const limit = 16_000;
		const noteText = output.length > limit ? `${output.slice(0, limit)}\n...[truncated]` : output;
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolResult.toolName || "tool"} result; call_id=${normalized.callId}]: ${noteText}`,
		} as ResponseInput[number]);
		return;
	}
	if (customCallIds?.has(normalized.callId)) {
		messages.push({
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		messages.push({
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !supportsImages) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push({
				type: "input_image",
				detail: block.detail ?? "auto",
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
	/**
	 * Called when a terminal `response.completed` or `response.incomplete` event
	 * is successfully processed. Only invoked on the successful-completion path;
	 * thrown failure (`response.failed`) and cancellation paths never call this.
	 * Used by callers to detect premature stream closure (i.e. the stream ended
	 * without a recognized terminal event).
	 */
	onCompleted?: () => void;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	type StreamingToolCallBlock = ToolCall & { partialJson: string; lastParseLen?: number; argumentsDone?: boolean };
	interface StreamingItem {
		item: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
		block: ThinkingContent | TextContent | StreamingToolCallBlock;
	}

	// Multiple items (parallel function_calls in particular) can be open at the same
	// time. OpenAI's spec routes every per-item event by `output_index`/`item_id`;
	// see https://github.com/can1357/oh-my-pi/issues/1880 — llama.cpp emits parallel
	// function_call deltas interleaved, and a singleton `current` reference would
	// fold them into the wrong block and drop arguments on every call but the last.
	//
	// OpenAI-compatible hosts can compound this by omitting `item.id` and
	// `output_index` on `output_item.added` while routing later argument deltas to
	// either the bare `call_id` or a synthesized `fc_<call_id>` item id. Register
	// both keys so each delta reaches its own block instead of falling back to the
	// most recently added parallel call.
	const openItemsByOutputIndex = new Map<number, StreamingItem>();
	const openItemsByItemId = new Map<string, StreamingItem>();
	const openItemsByPrefixedCallId = new Map<string, StreamingItem>();
	let lastOpenItem: StreamingItem | null = null;
	const openItemsInOrder: StreamingItem[] = [];

	const prefixedFunctionCallItemKey = (callId: string | undefined): string | undefined =>
		callId ? `fc_${callId}` : undefined;

	const registerOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.set(outputIndex, entry);
		if (itemId) openItemsByItemId.set(itemId, entry);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.set(alternateItemKey, entry);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey
		) {
			openItemsByPrefixedCallId.set(prefixedAlternateItemKey, entry);
		}
		openItemsInOrder.push(entry);
		lastOpenItem = entry;
	};
	const lookupOpenItem = (event: { output_index?: number; item_id?: string }): StreamingItem | undefined => {
		if (typeof event.output_index === "number") {
			const found = openItemsByOutputIndex.get(event.output_index);
			if (found) return found;
		}
		if (event.item_id) {
			const found = openItemsByItemId.get(event.item_id);
			if (found) return found;
		}
		// Fallback for tests / mock providers that omit identifiers on stream events.
		return lastOpenItem ?? undefined;
	};
	const hasOpenItemKey = (event: { output_index?: number; item_id?: string }): boolean =>
		typeof event.output_index === "number" || event.item_id !== undefined;
	const lookupOpenToolCallAlias = (
		event: { output_index?: number; item_id?: string },
		type: "function_call" | "custom_tool_call",
	): StreamingItem | undefined => {
		if (typeof event.output_index === "number") return lookupOpenItem(event);
		if (event.item_id) {
			// Prefixed call-id aliases share the same wire namespace as real call ids.
			// Argument/input events can use the prefixed form, while final
			// output_item.done events below use exact call ids; keep aliases in a
			// separate map so a real `call_id: "fc_x"` cannot overwrite the alias
			// for `call_id: "x"`.
			const alias = openItemsByPrefixedCallId.get(event.item_id);
			if (alias?.item.type === type) return alias;
			const exact = openItemsByItemId.get(event.item_id);
			if (exact) return exact;
		}
		return lookupOpenItem(event);
	};
	const lookupOpenFunctionCallItem = (event: {
		output_index?: number;
		item_id?: string;
	}): StreamingItem | undefined => {
		if (hasOpenItemKey(event)) return lookupOpenToolCallAlias(event, "function_call");
		for (const candidate of openItemsInOrder) {
			if (
				candidate.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block.argumentsDone
			) {
				return candidate;
			}
		}
		return lastOpenItem?.item.type === "function_call" ? lastOpenItem : undefined;
	};
	const closeOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem | undefined,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.delete(outputIndex);
		if (itemId) openItemsByItemId.delete(itemId);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.delete(alternateItemKey);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey &&
			openItemsByPrefixedCallId.get(prefixedAlternateItemKey) === entry
		) {
			openItemsByPrefixedCallId.delete(prefixedAlternateItemKey);
		}
		if (entry) {
			const index = openItemsInOrder.indexOf(entry);
			if (index >= 0) openItemsInOrder.splice(index, 1);
		}
		if (entry && lastOpenItem === entry) lastOpenItem = null;
	};
	const contentIndexOf = (block: ThinkingContent | TextContent | StreamingToolCallBlock): number =>
		output.content.indexOf(block);

	let sawFirstToken = false;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			if (!sawFirstToken) {
				sawFirstToken = true;
				options?.onFirstToken?.();
			}
			const item = event.item;
			if (item.type === "reasoning") {
				const block: ThinkingContent = { type: "thinking", thinking: "", itemId: item.id };
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "thinking_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "message") {
				const block: TextContent = { type: "text", text: "" };
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "text_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "function_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "custom_tool_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					// Preserve the raw wire name (e.g. `apply_patch`). The agent-loop
					// dispatcher matches it against both `Tool.name` and
					// `Tool.customWireName`, so this stays wire-accurate through
					// history replay while still routing to the right handler.
					name: item.name,
					arguments: { input: item.input ?? "" },
					customWireName: item.name,
					// Custom tools stream a raw string, but we reuse `partialJson` as the
					// accumulation buffer so later code that inspects the field still works.
					partialJson: item.input ?? "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning") {
				entry.item.summary = entry.item.summary || [];
				entry.item.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.item.summary = entry.item.summary || [];
				const lastPart = entry.item.summary[entry.item.summary.length - 1];
				if (lastPart) {
					entry.block.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: contentIndexOf(entry.block),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.item.summary = entry.item.summary || [];
				const lastPart = entry.item.summary[entry.item.summary.length - 1];
				if (lastPart) {
					entry.block.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: contentIndexOf(entry.block),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			// Raw reasoning text delta from local providers that stream thinking
			// directly rather than via the OpenAI summary tracking protocol.
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message") {
				entry.item.content = entry.item.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					entry.item.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				entry.item.content = entry.item.content || [];
				let lastPart = entry.item.content[entry.item.content.length - 1];
				if (lastPart?.type !== "output_text") {
					// `content_part.added` never arrived (lossy proxy) — synthesize the
					// part so live text still streams instead of freezing until the
					// item's output_item.done recovers the final text.
					lastPart = { type: "output_text", text: "", annotations: [] };
					entry.item.content.push(lastPart);
				}
				entry.block.text += event.delta;
				lastPart.text += event.delta;
				stream.push({
					type: "text_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				entry.item.content = entry.item.content || [];
				let lastPart = entry.item.content[entry.item.content.length - 1];
				if (lastPart?.type !== "refusal") {
					// Same lossy-proxy hardening as the output_text branch above.
					lastPart = { type: "refusal", refusal: "" };
					entry.item.content.push(lastPart);
				}
				entry.block.text += event.delta;
				lastPart.refusal += event.delta;
				stream.push({
					type: "text_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				const block = entry.block;
				block.partialJson += event.delta;
				const throttled = parseStreamingJsonThrottled(block.partialJson, block.lastParseLen ?? 0);
				if (throttled) {
					block.arguments = throttled.value;
					block.lastParseLen = throttled.parsedLen;
				}
				stream.push({
					type: "toolcall_delta",
					contentIndex: contentIndexOf(block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				const block = entry.block;
				block.partialJson = event.arguments;
				block.arguments = parseStreamingJson(block.partialJson);
				block.argumentsDone = true;
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { lastParseLen?: number }).lastParseLen;
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				const block = entry.block;
				block.partialJson += event.delta;
				block.arguments = { input: block.partialJson };
				stream.push({
					type: "toolcall_delta",
					contentIndex: contentIndexOf(block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				entry.block.partialJson = event.input;
				entry.block.arguments = { input: event.input };
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			const entry =
				item.type === "function_call" || item.type === "custom_tool_call"
					? lookupOpenItem({ output_index: event.output_index, item_id: item.id ?? item.call_id })
					: lookupOpenItem({ output_index: event.output_index, item_id: item.id });
			if (item.type === "reasoning") {
				const thinking =
					item.summary?.length > 0
						? item.summary.map(part => part.text).join("\n\n")
						: item.content?.[0]?.type === "reasoning_text"
							? (item.content[0].text ?? "")
							: "";
				// Prefer the routed entry; the bare itemId find misroutes when ids are
				// absent (`undefined === undefined` matches the FIRST thinking block) and
				// misses entirely when the done-event id drifts from the added-event id.
				const reasoningBlock =
					entry?.block.type === "thinking"
						? entry.block
						: (output.content.find(b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id) as
								| ThinkingContent
								| undefined);
				if (reasoningBlock) {
					reasoningBlock.thinking = thinking;
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					stream.push({
						type: "thinking_end",
						contentIndex: contentIndexOf(reasoningBlock),
						content: thinking,
						partial: output,
					});
				}
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "message") {
				const block = entry?.block.type === "text" ? entry.block : undefined;
				const text = item.content
					.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? "")))
					.join("");
				const textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				let contentIndex: number;
				if (block) {
					block.text = text;
					block.textSignature = textSignature;
					contentIndex = contentIndexOf(block);
				} else {
					// `output_item.added` never arrived (lossy proxy) — synthesize the
					// block so the final message still carries the authoritative text.
					const synthesized: TextContent = { type: "text", text, textSignature };
					output.content.push(synthesized);
					contentIndex = output.content.length - 1;
				}
				stream.push({ type: "text_end", contentIndex, content: text, partial: output });
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "function_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const args = block?.argumentsDone
					? block.arguments
					: block?.partialJson
						? parseStreamingJson(block.partialJson)
						: parseStreamingJson(item.arguments || "{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				let contentIndex: number;
				if (block) {
					// Persist the authoritative final args on the stored block. The
					// throttled delta parser may have skipped the last partial parse,
					// leaving block.arguments stale (often `{}`); the emitted toolCall
					// and the persisted block must agree.
					block.arguments = args;
					delete (block as { partialJson?: string }).partialJson;
					delete (block as { lastParseLen?: number }).lastParseLen;
					delete (block as { argumentsDone?: boolean }).argumentsDone;
					contentIndex = contentIndexOf(block);
				} else {
					// `output_item.added` never arrived (lossy proxy) — synthesize the
					// block so the final message carries the call the consumer was told
					// completed (the agent loop executes tools from message.content).
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const rawInput = block?.partialJson ? block.partialJson : (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				let contentIndex: number;
				if (block) {
					// Persist the final input on the stored block and drop the transient
					// accumulation buffer, mirroring the function_call branch above.
					block.arguments = { input: rawInput };
					delete (block as { partialJson?: string }).partialJson;
					delete (block as { lastParseLen?: number }).lastParseLen;
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			const response = event.response;
			// Finalize any toolCall block whose output_item.done never arrived: the
			// throttled delta parser may have left block.arguments stale, and the
			// toolUse override below would hand the agent incomplete arguments.
			for (const open of openItemsInOrder) {
				if (open.block.type !== "toolCall") continue;
				const block = open.block;
				if (block.partialJson && !block.argumentsDone) {
					block.arguments =
						open.item.type === "custom_tool_call"
							? { input: block.partialJson }
							: parseStreamingJson(block.partialJson);
				}
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { lastParseLen?: number }).lastParseLen;
				delete (block as { argumentsDone?: boolean }).argumentsDone;
			}
			if (response?.id) {
				output.responseId = response.id;
			}
			populateResponsesUsageFromResponse(output, response?.usage);
			calculateCost(model, output.usage);
			output.stopReason = mapOpenAIResponsesStopReason(response?.status);
			if (response?.status === "failed" || response?.status === "cancelled") {
				const error = response?.error ?? (response as any)?.status_details?.error;
				const details = response?.incomplete_details;
				const statusDetailsReason = (response as any)?.status_details?.reason;
				const message = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: typeof statusDetailsReason === "string" && statusDetailsReason.length > 0
							? `status_details: ${statusDetailsReason}`
							: "Unknown error (no error details in response)";
				throw new Error(message);
			}
			if (response?.status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
				// A content-filtered turn is a failure, not a token-cap truncation —
				// mapping it to "length" would route the agent loop into "shorten your
				// output" recovery against a filtered prompt.
				throw new Error("incomplete: content_filter");
			}
			if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
			// Codex-lineage backends/gateways mark an unfinished turn with
			// `end_turn: false` on the terminal event (the response ended on
			// commentary only). Not in the SDK types or the platform API today —
			// inert when absent. Same mapping as openai-codex-responses: surface a
			// non-terminal stop so the agent loop re-samples instead of ending the
			// turn.
			if ((response as { end_turn?: boolean } | undefined)?.end_turn === false && output.stopReason === "stop") {
				output.stopDetails = { type: "pause_turn" };
			}
			options?.onCompleted?.();
			// `response.completed`/`response.incomplete` is the last event of a
			// Responses stream. Stop pulling instead of waiting for the server to
			// close the connection: misbehaving providers keep the socket open
			// after the terminal event, which would park this loop until the idle
			// watchdog converts an already-successful turn into a timeout error.
			// Breaking unwinds the iterator chain (the consumer's `.return()`
			// reaches the SDK stream), actively releasing the connection.
			break;
		} else if (event.type === "error") {
			const err = (event as any).error ?? event;
			const code = err.code ?? "unknown";
			const message = err.message ?? "no message";
			throw new Error(`Error Code ${code}: ${message}`);
		} else if (event.type === "response.failed") {
			populateResponsesUsageFromResponse(output, event.response?.usage);
			const error = event.response?.error ?? (event.response as any)?.status_details?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(message);
		}
	}
}

export function mapOpenAIResponsesStopReason(status: ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			// Compile-time exhaustiveness; at runtime a brand-new status from the
			// server must degrade gracefully instead of failing a fully-streamed
			// response.
			const exhaustive: never = status;
			logger.warn("Unhandled OpenAI Responses stop reason", { status: exhaustive });
			return "stop";
		}
	}
}

/** Initial empty `AssistantMessage` that streaming providers accumulate into. */
export function createInitialResponsesAssistantMessage(api: Api, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Extension fields we add on top of `ResponseCreateParamsStreaming` across the Responses-family providers. */
export type ResponsesSamplingParamsExtras = {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type CommonResponsesParams = ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

type CommonSamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "maxTokens"
> & { serviceTier?: ServiceTier };

/**
 * Apply the common `StreamOptions` → Responses sampling-parameter mapping (max output tokens,
 * temperature, top-p/k, min-p, presence/repetition penalties, service tier). Mutates `params`.
 *
 * `max_output_tokens` is suppressed when {@link Model.omitMaxOutputTokens} is `true`, so
 * proxies (notably Ollama) that forward to upstream APIs with an unknown output-token cap
 * can let the upstream apply its own default instead of 400-ing on `maxTokens` values that
 * reflect the model's context window rather than the upstream output limit.
 */
export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	model: Pick<Model, "provider" | "omitMaxOutputTokens" | "maxTokens">,
): void {
	if (options?.maxTokens && !model.omitMaxOutputTokens) {
		params.max_output_tokens = Math.min(
			options.maxTokens,
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			OPENAI_MAX_OUTPUT_TOKENS,
		);
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;
	if (options?.minP !== undefined) params.min_p = options.minP;
	if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
	if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
	if (shouldSendServiceTier(options?.serviceTier, model.provider)) {
		const resolved = resolveServiceTier(options?.serviceTier, model.provider);
		if (resolved === "flex" || resolved === "scale" || resolved === "priority") {
			params.service_tier = resolved;
		}
	}
}

type ReasoningOptions = {
	reasoning?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
};

/**
 * Apply reasoning-related Responses parameters: enable encrypted reasoning content for replay,
 * set effort/summary when requested, and otherwise inject the "Juice: 0" no-reasoning hack
 * when `model.compat.requiresJuiceZeroHack` is set (GPT-5 family by default).
 * Mutates `params` and may push a developer message into `messages`. Returns
 * the number of per-turn trailing scaffolding items appended to `messages`
 * (the "Juice: 0" developer item), so callers doing stateful
 * `previous_response_id` chaining can exclude them from append-baseline math.
 *
 * @param omitReasoningEffort - When `true`, suppresses `params.reasoning.effort` from the wire
 *   body. Set by `xai-responses.ts` via {@link OpenAIResponsesOptions.omitReasoningEffort} for
 *   xAI Grok models that return HTTP 400 on any `reasoning.effort` value (e.g. grok-build,
 *   grok-4.20-0309-reasoning). When `true` and `options.reasoning` is set but
 *   `options.reasoningSummary` is absent, `params.reasoning` is intentionally omitted from the
 *   wire body entirely — these models reason natively at their own internal default effort level
 *   without needing explicit activation. Callers that pass `options.reasoning` for such models
 *   should expect this documented downgrade: the model will reason, but at its default effort.
 */
export function applyResponsesReasoningParams<P extends ResponseCreateParamsStreaming>(
	params: P,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	options: ReasoningOptions | undefined,
	messages: ResponseInput,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning: boolean = true,
	omitReasoningEffort: boolean = false,
): number {
	if (!model.reasoning) return 0;
	// Always request encrypted reasoning content so reasoning items can be replayed in
	// multi-turn conversations when store is false (items aren't persisted server-side, so
	// we must include the full content). See: https://github.com/can1357/oh-my-pi/issues/41
	if (includeEncryptedReasoning) {
		const include = params.include ?? [];
		if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
		params.include = include;
	}

	if (options?.reasoning || options?.reasoningSummary !== undefined) {
		// Suppress the effort dial entirely when the upstream provider rejects
		// `reasoning.effort` for this model (xAI Grok models outside the
		// effort-capable allowlist 400 with "Model X does not support parameter
		// reasoningEffort"). Default is false to preserve existing behavior for
		// every non-xAI caller.
		if (omitReasoningEffort) {
			// Still honor reasoningSummary when explicitly requested; xAI
			// accepts the summary field on every reasoning-capable model.
			// When only options.reasoning (effort level) is set, params.reasoning
			// is intentionally omitted — see @param omitReasoningEffort above.
			if (options?.reasoningSummary !== undefined && options?.reasoningSummary !== null) {
				type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
		} else {
			const requested = options?.reasoning || "medium";
			type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
			const reasoningParams: ReasoningParam = {
				effort: (mapEffort ? mapEffort(requested) : requested) as ReasoningParam["effort"],
			};
			if (options?.reasoningSummary !== null) {
				reasoningParams.summary = options?.reasoningSummary || "auto";
			}
			params.reasoning = reasoningParams as P["reasoning"];
		}
	} else if (model.compat.requiresJuiceZeroHack) {
		// Jesus Christ, see https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7
		messages.push({
			role: "developer",
			content: [{ type: "input_text", text: "# Juice: 0 !important" }],
		});
		return 1;
	}
	return 0;
}

/** Populate `output.usage` from a Responses-API `response.usage` payload. Does not invoke `calculateCost`. */
export function populateResponsesUsageFromResponse(
	output: AssistantMessage,
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				total_tokens?: number | null;
				input_tokens_details?: { cached_tokens?: number | null } | null;
				output_tokens_details?: { reasoning_tokens?: number | null } | null;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;
	const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
	const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
	// Wholesale replacement must not drop provider-annotated extras (Copilot
	// premium-request accounting): the failed/cancelled paths throw right after
	// this call with no later chance to re-apply.
	const premiumRequests = output.usage.premiumRequests;
	output.usage = {
		input: (usage.input_tokens || 0) - cachedTokens,
		output: usage.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		totalTokens: usage.total_tokens || 0,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (premiumRequests !== undefined) {
		output.usage.premiumRequests = premiumRequests;
	}
}

/**
 * Strict-prefix delta for stateful `previous_response_id` chaining (used by the
 * platform Responses provider and the Codex provider on both transports):
 * returns the input items the current request appends beyond the previous
 * request's input plus the previous response's output items, or null when the
 * request options differ or history mutated (the chain must break). Per-turn
 * `client_metadata` (e.g. rotating turn ids) is excluded from the option
 * comparison; codex-rs excludes it from the same check.
 */
export function buildResponsesDeltaInput<TItem>(
	previous: { input?: unknown } | undefined,
	previousResponseItems: readonly TItem[] | undefined,
	current: { input?: unknown },
): TItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	const previousWithoutInput = { ...previous, input: undefined, client_metadata: undefined };
	const currentWithoutInput = { ...current, input: undefined, client_metadata: undefined };
	if (JSON.stringify(previousWithoutInput) !== JSON.stringify(currentWithoutInput)) {
		return null;
	}
	const baseline = [...previous.input, ...(previousResponseItems ?? [])];
	if (current.input.length <= baseline.length) return null;
	for (let index = 0; index < baseline.length; index += 1) {
		if (JSON.stringify(baseline[index]) !== JSON.stringify(current.input[index])) {
			return null;
		}
	}
	return current.input.slice(baseline.length) as TItem[];
}
