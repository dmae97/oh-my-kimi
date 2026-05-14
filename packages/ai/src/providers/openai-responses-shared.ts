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
import { parseStreamingJson } from "../utils/json-parse";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";

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
	let currentItem:
		| ResponseReasoningItem
		| ResponseOutputMessage
		| ResponseFunctionToolCall
		| ResponseCustomToolCall
		| null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
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
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "", itemId: item.id };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "custom_tool_call") {
				currentItem = item;
				currentBlock = {
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
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem?.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			// Raw reasoning text delta from local providers that stream thinking
			// directly rather than via the OpenAI summary tracking protocol.
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				const lastPart = currentItem.content?.[currentItem.content.length - 1];
				if (lastPart?.type === "output_text") {
					currentBlock.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				const lastPart = currentItem.content?.[currentItem.content.length - 1];
				if (lastPart?.type === "refusal") {
					currentBlock.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			if (currentItem?.type === "custom_tool_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = { input: currentBlock.partialJson };
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			if (currentItem?.type === "custom_tool_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson = event.input;
				currentBlock.arguments = { input: event.input };
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
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
					const reasoningBlockIndex = output.content.indexOf(reasoningBlock);
					stream.push({
						type: "thinking_end",
						contentIndex: reasoningBlockIndex,
						content: thinking,
						partial: output,
					});
				}
				if ((currentBlock as ThinkingContent | null)?.itemId === item.id) currentBlock = null;
			} else if (item.type === "message" && currentBlock?.type === "text") {
				currentBlock.text = item.content
					.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? "")))
					.join("");
				currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "function_call") {
				const args =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? parseStreamingJson(currentBlock.partialJson)
						: parseStreamingJson(item.arguments || "{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const rawInput =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? currentBlock.partialJson
						: (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
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
 */
export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	provider: string,
): void {
	if (options?.maxTokens) params.max_output_tokens = options.maxTokens;
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;
	if (options?.minP !== undefined) params.min_p = options.minP;
	if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
	if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
	if (shouldSendServiceTier(options?.serviceTier, provider)) {
		params.service_tier = options.serviceTier;
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
 */
export function applyResponsesReasoningParams<P extends OpenAI.Responses.ResponseCreateParamsStreaming>(
	params: P,
	model: Model<Api>,
	options: ReasoningOptions | undefined,
	messages: ResponseInput,
	mapEffort?: (effort: string) => string,
): void {
	if (!model.reasoning) return;
	// Always request encrypted reasoning content so reasoning items can be replayed in
	// multi-turn conversations when store is false (items aren't persisted server-side, so
	// we must include the full content). See: https://github.com/can1357/oh-my-pi/issues/41
	params.include = ["reasoning.encrypted_content"];

	if (options?.reasoning || options?.reasoningSummary !== undefined) {
		const requested = options?.reasoning || "medium";
		type ReasoningParam = NonNullable<OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"]>;
		const reasoningParams: ReasoningParam = {
			effort: (mapEffort ? mapEffort(requested) : requested) as ReasoningParam["effort"],
		};
		if (options?.reasoningSummary !== null) {
			reasoningParams.summary = options?.reasoningSummary || "auto";
		}
		params.reasoning = reasoningParams as P["reasoning"];
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
