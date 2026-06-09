import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import type OpenAI from "openai";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses";
import { calculateCost } from "../models";
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
			detail: "auto",
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
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (!includeThinkingSignatures) {
				continue;
			}
			if (block.thinkingSignature) {
				outputItems.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				msgId = `msg_${msgIndex}`;
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
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		return;
	}

	const output = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: "(see attached image)"
	).toWellFormed();
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
				detail: "auto",
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
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
	// llama.cpp's `to_json_oaicompat_resp` (issue #2015) compounds this: `output_item.added`
	// for function_call/custom_tool_call carries `item.call_id` but no `item.id` and no
	// `output_index`, while the matching `function_call_arguments.delta` carries
	// `item_id = "fc_<call_id>"`. Registering function-call items by `call_id` as a
	// secondary key lets the delta lookup find the right block on hosts that emit one
	// identifier but not the other.
	const openItemsByOutputIndex = new Map<number, StreamingItem>();
	const openItemsByItemId = new Map<string, StreamingItem>();
	let lastOpenItem: StreamingItem | null = null;
	const openItemsInOrder: StreamingItem[] = [];

	const registerOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem,
		alternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.set(outputIndex, entry);
		if (itemId) openItemsByItemId.set(itemId, entry);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.set(alternateItemKey, entry);
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
	const lookupOpenFunctionCallItem = (event: {
		output_index?: number;
		item_id?: string;
	}): StreamingItem | undefined => {
		if (hasOpenItemKey(event)) return lookupOpenItem(event);
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
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.delete(outputIndex);
		if (itemId) openItemsByItemId.delete(itemId);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.delete(alternateItemKey);
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
				registerOpenItem(event.output_index, item.id, { item, block }, item.call_id);
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
				registerOpenItem(event.output_index, item.id, { item, block }, item.call_id);
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
				const lastPart = entry.item.content?.[entry.item.content.length - 1];
				if (lastPart?.type === "output_text") {
					entry.block.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: contentIndexOf(entry.block),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				const lastPart = entry.item.content?.[entry.item.content.length - 1];
				if (lastPart?.type === "refusal") {
					entry.block.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: contentIndexOf(entry.block),
						delta: event.delta,
						partial: output,
					});
				}
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
			const entry = lookupOpenItem(event);
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
			const entry = lookupOpenItem(event);
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
				const reasoningBlock = output.content.find(
					b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id,
				) as ThinkingContent | undefined;
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
			} else if (item.type === "message" && entry?.block.type === "text") {
				const block = entry.block;
				block.text = item.content
					.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? "")))
					.join("");
				block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: contentIndexOf(block),
					content: block.text,
					partial: output,
				});
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
				if (block) {
					// Persist the authoritative final args on the stored block. The
					// throttled delta parser may have skipped the last partial parse,
					// leaving block.arguments stale (often `{}`); the emitted toolCall
					// and the persisted block must agree.
					block.arguments = args;
					delete (block as { partialJson?: string }).partialJson;
					delete (block as { lastParseLen?: number }).lastParseLen;
					delete (block as { argumentsDone?: boolean }).argumentsDone;
				}
				const contentIndex = block ? contentIndexOf(block) : output.content.length - 1;
				closeOpenItem(event.output_index, item.id, entry, item.call_id);
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
				const contentIndex = block ? contentIndexOf(block) : output.content.length - 1;
				closeOpenItem(event.output_index, item.id, entry, item.call_id);
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			const response = event.response;
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
			if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
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

export function mapOpenAIResponsesStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
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
			const exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${exhaustive}`);
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

type CommonResponsesParams = OpenAI.Responses.ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

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
		params.max_output_tokens = Math.min(options.maxTokens, model.maxTokens, OPENAI_MAX_OUTPUT_TOKENS);
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
 * set effort/summary when requested, and otherwise inject the GPT-5 "Juice: 0" no-reasoning hack.
 * Mutates `params` and may push a developer message into `messages`.
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
export function applyResponsesReasoningParams<P extends OpenAI.Responses.ResponseCreateParamsStreaming>(
	params: P,
	model: Model<Api>,
	options: ReasoningOptions | undefined,
	messages: ResponseInput,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning: boolean = true,
	omitReasoningEffort: boolean = false,
): void {
	if (!model.reasoning) return;
	// Always request encrypted reasoning content so reasoning items can be replayed in
	// multi-turn conversations when store is false (items aren't persisted server-side, so
	// we must include the full content). See: https://github.com/can1357/oh-my-pi/issues/41
	if (includeEncryptedReasoning) {
		params.include = ["reasoning.encrypted_content"];
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
				type ReasoningParam = NonNullable<OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
		} else {
			const requested = options?.reasoning || "medium";
			type ReasoningParam = NonNullable<OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"]>;
			const reasoningParams: ReasoningParam = {
				effort: (mapEffort ? mapEffort(requested) : requested) as ReasoningParam["effort"],
			};
			if (options?.reasoningSummary !== null) {
				reasoningParams.summary = options?.reasoningSummary || "auto";
			}
			params.reasoning = reasoningParams as P["reasoning"];
		}
	} else if (model.name.toLowerCase().startsWith("gpt-5")) {
		// Jesus Christ, see https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7
		messages.push({
			role: "developer",
			content: [{ type: "input_text", text: "# Juice: 0 !important" }],
		});
	}
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
	output.usage = {
		input: (usage.input_tokens || 0) - cachedTokens,
		output: usage.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		totalTokens: usage.total_tokens || 0,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
