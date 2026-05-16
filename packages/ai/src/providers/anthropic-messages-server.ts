import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	RedactedThinkingContent,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import {
	type AnthropicAssistantContentBlock,
	type AnthropicMessage,
	type AnthropicSystem,
	type AnthropicTool,
	type AnthropicToolChoice,
	type AnthropicToolResultContent,
	type AnthropicUserContentBlock,
	anthropicMessagesRequestSchema,
} from "./anthropic-messages-server-schema";

/**
 * Anthropic Messages API (https://docs.anthropic.com/en/api/messages) ↔ pi-ai
 * gateway translation. Inbound: foreign HTTP body → omp Context. Outbound:
 * omp AssistantMessage[Stream] → Anthropic-shaped JSON / SSE.
 */

import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";

export type { ParsedRequest };

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

type ImageContentPart = { type: "image"; data: string; mimeType: string };

function buildSystemPrompt(raw: AnthropicSystem): string[] | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") return raw.length > 0 ? [raw] : undefined;
	const parts = raw.map(block => block.text).filter(text => text.length > 0);
	return parts.length > 0 ? [parts.join("\n\n")] : undefined;
}

function makeUserMessage(parts: (TextContent | ImageContentPart)[], timestamp: number): UserMessage {
	return {
		role: "user",
		content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
		timestamp,
	};
}

function toolResultPartsFromBlocks(
	content: AnthropicToolResultContent[] | string | undefined,
): (TextContent | ImageContentPart)[] {
	if (content === undefined) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	const out: (TextContent | ImageContentPart)[] = [];
	for (const block of content) {
		if (block.type === "text") {
			out.push({ type: "text", text: block.text });
			continue;
		}
		// block.type === "image" — schema only accepts base64 sources.
		if (block.source.type === "base64") {
			out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
		}
	}
	return out;
}

function walkUserContent(
	blocks: string | AnthropicUserContentBlock[],
	timestamp: number,
): (UserMessage | ToolResultMessage)[] {
	const messages: (UserMessage | ToolResultMessage)[] = [];
	const userParts: (TextContent | ImageContentPart)[] = [];
	const flush = () => {
		if (userParts.length === 0) return;
		messages.push(makeUserMessage(userParts.splice(0), timestamp));
	};
	if (typeof blocks === "string") {
		if (blocks.length > 0) userParts.push({ type: "text", text: blocks });
		flush();
		return messages;
	}
	for (const block of blocks) {
		if (block.type === "text") {
			userParts.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			if (block.source.type !== "base64") continue;
			userParts.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
		} else if (block.type === "tool_result") {
			// tool_result blocks must follow any plain text/image siblings.
			if (userParts.length > 0) {
				throw new Error("anthropic-messages: user text/image blocks before tool_result are not supported");
			}
			messages.push({
				role: "toolResult",
				toolCallId: block.tool_use_id,
				// Anthropic tool_results don't carry the tool name; downstream can rehydrate.
				toolName: "",
				content: toolResultPartsFromBlocks(block.content as AnthropicToolResultContent[] | string | undefined),
				isError: block.is_error === true,
				timestamp,
			});
		}
	}
	flush();
	return messages;
}

function walkAssistantContent(
	blocks: string | AnthropicAssistantContentBlock[],
): (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[] {
	const out: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[] = [];
	if (typeof blocks === "string") {
		if (blocks.length > 0) out.push({ type: "text", text: blocks });
		return out;
	}
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				out.push({ type: "text", text: block.text });
				break;
			case "thinking": {
				const tc: ThinkingContent = { type: "thinking", thinking: block.thinking };
				if (block.signature !== undefined) tc.thinkingSignature = block.signature;
				out.push(tc);
				break;
			}
			case "redacted_thinking":
				out.push({ type: "redactedThinking", data: block.data });
				break;
			case "tool_use":
				out.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.input ?? {},
				});
				break;
		}
	}
	return out;
}

function walkTools(tools: AnthropicTool[] | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? "",
		parameters: tool.input_schema as Record<string, unknown>,
	}));
}

function mapToolChoice(choice: AnthropicToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (!choice) return undefined;
	switch (choice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return { name: choice.name };
	}
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };
type HasCacheControl = { cache_control?: AnthropicCacheControl };

function readCacheControl(value: unknown): AnthropicCacheControl | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const cc = (value as HasCacheControl).cache_control;
	if (!cc || typeof cc !== "object" || cc.type !== "ephemeral") return undefined;
	return cc;
}

/**
 * Anthropic clients annotate caching breakpoints per block via
 * `cache_control: { type: "ephemeral", ttl?: "1h"|"5m" }`. pi-ai's
 * `cacheRetention` is per-request, not per-block, and its anthropic provider
 * re-applies breakpoints itself on the rebuilt outbound wire. Scan every
 * block once and return the strongest retention requested: any `ttl: "1h"`
 * promotes the request to "long", anything else ephemeral maps to "short".
 */
function deriveCacheRetention(data: {
	system?: unknown;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}): "short" | "long" | undefined {
	let strongest: "short" | "long" | undefined;
	const visit = (cc: AnthropicCacheControl | undefined): void => {
		if (!cc) return;
		if (cc.ttl === "1h") strongest = "long";
		else strongest ??= "short";
	};
	if (Array.isArray(data.system)) {
		for (const block of data.system) visit(readCacheControl(block));
	}
	for (const message of data.messages) {
		if (message === null || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) visit(readCacheControl(block));
	}
	if (data.tools) {
		for (const tool of data.tools) visit(readCacheControl(tool));
	}
	return strongest;
}

export function parseRequest(body: unknown): ParsedRequest {
	const parsed = anthropicMessagesRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`anthropic-messages: ${parsed.error.message}`);
	}
	const data = parsed.data;

	const now = Date.now();
	const messages: Message[] = [];
	for (const message of data.messages as AnthropicMessage[]) {
		if (message.role === "user") {
			for (const m of walkUserContent(message.content, now)) messages.push(m);
		} else {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: walkAssistantContent(message.content),
				api: "anthropic-messages",
				provider: "anthropic",
				model: data.model,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: now,
			};
			messages.push(assistant);
		}
	}

	const options: ParsedRequest["options"] = {
		maxOutputTokens: data.max_tokens,
	};
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.top_k !== undefined) options.topK = data.top_k;
	if (data.stop_sequences) options.stopSequences = data.stop_sequences;
	const toolChoice = mapToolChoice(data.tool_choice as AnthropicToolChoice | undefined);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.thinking) {
		switch (data.thinking.type) {
			case "enabled":
				options.thinkingBudget = data.thinking.budget_tokens;
				break;
			case "disabled":
				options.disableReasoning = true;
				break;
			case "adaptive":
				if (data.thinking.budget_tokens !== undefined) {
					options.thinkingBudget = data.thinking.budget_tokens;
				}
				break;
		}
	}
	const cacheRetention = deriveCacheRetention(data);
	if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;

	return {
		modelId: data.model,
		context: {
			systemPrompt: buildSystemPrompt(data.system as AnthropicSystem),
			messages,
			tools: walkTools(data.tools as AnthropicTool[] | undefined),
		},
		stream: data.stream === true,
		options,
	};
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ---------------------------------------------------------------------------
// Outbound encoding
// ---------------------------------------------------------------------------

function newMessageId(): string {
	const hex = (globalThis.crypto?.randomUUID?.() ?? randomFallback()).replace(/-/g, "").slice(0, 24);
	return `msg_${hex}`;
}

function randomFallback(): string {
	// Sufficient for tests / environments without crypto.randomUUID
	const buf = new Uint8Array(16);
	for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
	const hex = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapStopReasonOut(reason: StopReason): "end_turn" | "max_tokens" | "tool_use" {
	switch (reason) {
		case "length":
			return "max_tokens";
		case "toolUse":
			return "tool_use";
		default:
			return "end_turn";
	}
}

function encodeContentBlocks(message: AssistantMessage): Record<string, unknown>[] {
	const blocks: Record<string, unknown>[] = [];
	for (const c of message.content) {
		switch (c.type) {
			case "text":
				blocks.push({ type: "text", text: c.text });
				break;
			case "thinking": {
				const b: Record<string, unknown> = { type: "thinking", thinking: c.thinking };
				if (c.thinkingSignature) b.signature = c.thinkingSignature;
				blocks.push(b);
				break;
			}
			case "redactedThinking":
				blocks.push({ type: "redacted_thinking", data: c.data });
				break;
			case "toolCall":
				blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
				break;
		}
	}
	return blocks;
}

function encodeUsage(message: AssistantMessage): Record<string, unknown> {
	return {
		input_tokens: message.usage.input,
		output_tokens: message.usage.output,
		cache_read_input_tokens: message.usage.cacheRead,
		cache_creation_input_tokens: message.usage.cacheWrite,
	};
}

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? `anthropic-messages: upstream ${message.stopReason}`);
	}
	return {
		id: message.responseId ?? newMessageId(),
		type: "message",
		role: "assistant",
		model: requestedModelId,
		content: encodeContentBlocks(message),
		stop_reason: mapStopReasonOut(message.stopReason),
		stop_sequence: null,
		usage: encodeUsage(message),
	};
}

// ---------------------------------------------------------------------------
// Streaming encoder
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

function sseFrame(event: string, data: Record<string, unknown>): Uint8Array {
	return ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type BlockKind = "text" | "thinking" | "tool_use";

interface OpenBlock {
	index: number;
	kind: BlockKind;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const messageId = newMessageId();
			let started = false;
			const open = new Map<number, OpenBlock>();

			const ensureStart = (partial: AssistantMessage) => {
				if (started) return;
				started = true;
				controller.enqueue(
					sseFrame("message_start", {
						type: "message_start",
						message: {
							id: messageId,
							type: "message",
							role: "assistant",
							model: requestedModelId,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: encodeUsage(partial),
						},
					}),
				);
			};

			const closeBlock = (index: number) => {
				if (!open.has(index)) return;
				controller.enqueue(sseFrame("content_block_stop", { type: "content_block_stop", index }));
				open.delete(index);
			};

			try {
				for await (const ev of events) {
					switch (ev.type) {
						case "start":
							ensureStart(ev.partial);
							break;
						case "text_start": {
							ensureStart(ev.partial);
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "text" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: { type: "text", text: "" },
								}),
							);
							break;
						}
						case "text_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "text_delta", text: ev.delta },
								}),
							);
							break;
						case "text_end":
							closeBlock(ev.contentIndex);
							break;
						case "thinking_start": {
							ensureStart(ev.partial);
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "thinking" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: { type: "thinking", thinking: "" },
								}),
							);
							break;
						}
						case "thinking_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "thinking_delta", thinking: ev.delta },
								}),
							);
							break;
						case "thinking_end": {
							const c = ev.partial.content[ev.contentIndex];
							if (c?.type === "thinking" && c.thinkingSignature) {
								controller.enqueue(
									sseFrame("content_block_delta", {
										type: "content_block_delta",
										index: ev.contentIndex,
										delta: { type: "signature_delta", signature: c.thinkingSignature },
									}),
								);
							}
							closeBlock(ev.contentIndex);
							break;
						}
						case "toolcall_start": {
							ensureStart(ev.partial);
							const tc = ev.partial.content[ev.contentIndex] as ToolCall | undefined;
							open.set(ev.contentIndex, { index: ev.contentIndex, kind: "tool_use" });
							controller.enqueue(
								sseFrame("content_block_start", {
									type: "content_block_start",
									index: ev.contentIndex,
									content_block: {
										type: "tool_use",
										id: tc?.id ?? "",
										name: tc?.name ?? "",
										input: {},
									},
								}),
							);
							break;
						}
						case "toolcall_delta":
							controller.enqueue(
								sseFrame("content_block_delta", {
									type: "content_block_delta",
									index: ev.contentIndex,
									delta: { type: "input_json_delta", partial_json: ev.delta },
								}),
							);
							break;
						case "toolcall_end":
							closeBlock(ev.contentIndex);
							break;
						case "done": {
							for (const idx of [...open.keys()]) closeBlock(idx);
							controller.enqueue(
								sseFrame("message_delta", {
									type: "message_delta",
									delta: { stop_reason: mapStopReasonOut(ev.reason), stop_sequence: null },
									usage: encodeUsage(ev.message),
								}),
							);
							controller.enqueue(sseFrame("message_stop", { type: "message_stop" }));
							controller.close();
							return;
						}
						case "error": {
							const msg = ev.error.errorMessage ?? "stream error";
							controller.enqueue(
								sseFrame("error", { type: "error", error: { type: "api_error", message: msg } }),
							);
							controller.close();
							return;
						}
					}
				}
				// stream ended without explicit done; close gracefully
				for (const idx of [...open.keys()]) closeBlock(idx);
				controller.enqueue(sseFrame("message_stop", { type: "message_stop" }));
				controller.close();
			} catch (err) {
				controller.enqueue(
					sseFrame("error", {
						type: "error",
						error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
					}),
				);
				controller.close();
			}
		},
	});
}
