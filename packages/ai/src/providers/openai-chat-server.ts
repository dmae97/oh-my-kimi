import { randomUUID } from "node:crypto";
/**
 * Parsed inbound OpenAI chat-completions request, ready to feed into pi-ai
 * `stream(model, context, options)`.
 */
import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	StopReason,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	TSchema,
} from "../types";
import {
	type OpenAIChatContentPart,
	type OpenAIChatMessage,
	type OpenAIChatTool,
	type OpenAIChatToolCall,
	type OpenAIChatToolChoice,
	openaiChatRequestSchema,
} from "./openai-chat-server-schema";

export type { ParsedRequest };

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

export function parseRequest(body: unknown): ParsedRequest {
	const parsed = openaiChatRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`openai-chat: ${parsed.error.message}`);
	}
	const data = parsed.data;

	const now = Date.now();
	const systemParts: string[] = [];
	const messages: Message[] = [];

	for (const m of data.messages as OpenAIChatMessage[]) {
		switch (m.role) {
			case "system": {
				const text = stringifyContent(m.content);
				if (text.length > 0) systemParts.push(text);
				break;
			}
			case "developer":
				messages.push({ role: "developer", content: parseUserLikeContent(m.content), timestamp: now });
				break;
			case "user":
				messages.push({ role: "user", content: parseUserLikeContent(m.content), timestamp: now });
				break;
			case "assistant":
				messages.push(
					buildAssistantMessage(
						(m.content ?? undefined) as string | OpenAIChatContentPart[] | undefined,
						m.tool_calls,
						data.model,
						now,
					),
				);
				break;
			case "tool":
				messages.push(buildToolMessage(m.content, m.tool_call_id, now));
				break;
		}
	}

	const tools = data.tools ? buildTools(data.tools as OpenAIChatTool[]) : undefined;

	const context: Context = {
		messages,
		...(systemParts.length > 0 ? { systemPrompt: [systemParts.join("\n\n")] } : {}),
		...(tools ? { tools } : {}),
	};

	// Prefer max_completion_tokens (newer) over max_tokens.
	const maxOutputTokens = data.max_completion_tokens ?? data.max_tokens;
	const stopSequences = normalizeStop(data.stop);
	const toolChoice = normalizeToolChoice(data.tool_choice);
	const includeStreamingUsage = data.stream_options?.include_usage === true;

	const extra: Record<string, unknown> = {};
	let hasExtra = false;
	const carry = <K extends string>(key: K, value: unknown) => {
		if (value === undefined) return;
		extra[key] = value;
		hasExtra = true;
	};
	carry("response_format", data.response_format);
	carry("seed", data.seed);
	carry("presence_penalty", data.presence_penalty);
	carry("frequency_penalty", data.frequency_penalty);
	carry("logit_bias", data.logit_bias);
	carry("user", data.user);
	if (includeStreamingUsage) {
		extra.includeStreamingUsage = true;
		hasExtra = true;
	}

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options: {
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
			...(data.top_p !== undefined ? { topP: data.top_p } : {}),
			...(stopSequences ? { stopSequences } : {}),
			...(toolChoice !== undefined ? { toolChoice } : {}),
			...(hasExtra ? { extra } : {}),
		},
	};
}

function stringifyContent(content: string | OpenAIChatContentPart[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	const out: string[] = [];
	for (const part of content) {
		if (part.type === "text") out.push(part.text);
	}
	return out.join("");
}

function parseUserLikeContent(
	content: string | OpenAIChatContentPart[] | undefined,
): string | (TextContent | ImageContent)[] {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	const parts: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "text") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type !== "image_url") continue;
		const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
		const decoded = decodeDataUri(url);
		if (decoded) {
			parts.push({ type: "image", data: decoded.data, mimeType: decoded.mimeType });
		} else {
			// No image fetcher available in the gateway; surface as a text placeholder so
			// downstream providers still receive a coherent message.
			parts.push({ type: "text", text: `[image: ${url}]` });
		}
	}
	return parts;
}

function decodeDataUri(url: string): { data: string; mimeType: string } | undefined {
	if (!url.startsWith("data:")) return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const header = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isBase64 = header.endsWith(";base64");
	const mimeType = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
	const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");
	return { data, mimeType };
}

function buildAssistantMessage(
	content: string | OpenAIChatContentPart[] | undefined,
	toolCalls: OpenAIChatToolCall[] | undefined,
	modelId: string,
	now: number,
): AssistantMessage {
	const parts: AssistantMessage["content"] = [];
	const text = stringifyContent(content);
	if (text.length > 0) parts.push({ type: "text", text });
	if (toolCalls) {
		for (const raw of toolCalls) {
			// Schema only accepts type:"function" (or omitted); narrow the SDK
			// union here so the custom-tool variant doesn't trip TS.
			if (raw.type !== undefined && raw.type !== "function") continue;
			const fn = (raw as { function: { name: string; arguments: string } }).function;
			const argsStr = fn.arguments;
			let args: Record<string, unknown> = {};
			if (argsStr.length > 0) {
				try {
					const v: unknown = JSON.parse(argsStr);
					args =
						v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { __raw: argsStr };
				} catch {
					args = { __raw: argsStr };
				}
			}
			const call: ToolCall = { type: "toolCall", id: raw.id, name: fn.name, arguments: args };
			parts.push(call);
		}
	}
	return {
		role: "assistant",
		content: parts,
		api: "openai-completions",
		provider: "openai",
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
		timestamp: now,
	};
}

function buildToolMessage(
	content: string | OpenAIChatContentPart[] | undefined,
	toolCallId: string | undefined,
	now: number,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCallId ?? "",
		// OpenAI chat-completions doesn't carry the tool name on tool-role messages;
		// downstream providers that need it tolerate an empty string.
		toolName: "",
		content: [{ type: "text", text: stringifyContent(content) }],
		isError: false,
		timestamp: now,
	};
}

function buildTools(tools: OpenAIChatTool[]): Tool[] | undefined {
	if (tools.length === 0) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		if (t.type !== "function") continue;
		out.push({
			name: t.function.name,
			description: t.function.description ?? "",
			parameters: (t.function.parameters ?? {}) as Record<string, unknown> as TSchema,
		});
	}
	return out;
}

function normalizeStop(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return [value];
	return value.length > 0 ? value : undefined;
}

function normalizeToolChoice(value: OpenAIChatToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	if ("function" in value) return { name: value.function.name };
	return undefined;
}

// ---------------------------------------------------------------------------
// encodeResponse (non-streaming)
// ---------------------------------------------------------------------------

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const { text, toolCalls } = flattenAssistant(message);

	const responseMessage: Record<string, unknown> = {
		role: "assistant",
		content: text.length > 0 ? text : null,
	};
	if (toolCalls.length > 0) {
		responseMessage.tool_calls = toolCalls.map(tc => ({
			id: tc.id,
			type: "function",
			function: { name: tc.name, arguments: stringifyArgs(tc.arguments) },
		}));
	}

	return {
		id: makeId(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: requestedModelId,
		choices: [
			{
				index: 0,
				message: responseMessage,
				finish_reason: mapFinishReason(message.stopReason, toolCalls.length > 0),
			},
		],
		usage: buildUsage(message),
	};
}

function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: message.usage.output,
		total_tokens: promptTokens + message.usage.output,
		prompt_tokens_details: { cached_tokens: message.usage.cacheRead },
	};
}

function flattenAssistant(message: AssistantMessage): { text: string; toolCalls: ToolCall[] } {
	let text = "";
	const toolCalls: ToolCall[] = [];
	for (const part of message.content) {
		switch (part.type) {
			case "text":
				text += part.text;
				break;
			case "toolCall":
				toolCalls.push(part);
				break;
			// thinking / redactedThinking: dropped — openai chat-completions has no reasoning channel.
		}
	}
	return { text, toolCalls };
}

function isOnlyRaw(args: Record<string, unknown>): boolean {
	for (const k in args) {
		if (k !== "__raw") return false;
	}
	return true;
}

function stringifyArgs(args: Record<string, unknown>): string {
	// `__raw` is our fallback marker for un-parseable inbound args; preserve it verbatim on the way out.
	if (typeof args.__raw === "string" && isOnlyRaw(args)) return args.__raw;
	try {
		return JSON.stringify(args);
	} catch {
		return "{}";
	}
}

function mapFinishReason(reason: StopReason, hasToolCalls: boolean): string {
	if (reason === "toolUse" || (hasToolCalls && reason === "stop")) return "tool_calls";
	if (reason === "length") return "length";
	return "stop";
}

function makeId(): string {
	return `chatcmpl-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// encodeStream (SSE)
// ---------------------------------------------------------------------------

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options?: ParsedRequest["options"],
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const id = makeId();
	const created = Math.floor(Date.now() / 1000);
	const includeUsage = options?.extra?.includeStreamingUsage === true;

	const baseChunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model: requestedModelId,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(includeUsage ? { usage: null } : {}),
	});

	const writeSse = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown): void => {
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
	};

	const writeUsage = (controller: ReadableStreamDefaultController<Uint8Array>, message: AssistantMessage): void => {
		writeSse(controller, {
			id,
			object: "chat.completion.chunk",
			created,
			model: requestedModelId,
			choices: [],
			usage: buildUsage(message),
		});
	};

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			// contentIndex (from pi-ai events) -> tool_calls index on the wire.
			const toolIndexByContentIndex = new Map<number, number>();
			let nextToolIndex = 0;
			let hasToolCalls = false;
			let finishReason: string = "stop";

			try {
				// Initial role chunk.
				writeSse(controller, baseChunk({ role: "assistant" }, null));

				for await (const event of events) {
					switch (event.type) {
						case "text_delta":
							if (event.delta.length > 0) {
								writeSse(controller, baseChunk({ content: event.delta }, null));
							}
							break;

						case "toolcall_start": {
							hasToolCalls = true;
							const idx = nextToolIndex++;
							toolIndexByContentIndex.set(event.contentIndex, idx);
							const partial = event.partial.content[event.contentIndex];
							const call = partial && partial.type === "toolCall" ? partial : undefined;
							writeSse(
								controller,
								baseChunk(
									{
										tool_calls: [
											{
												index: idx,
												id: call?.id ?? "",
												type: "function",
												function: { name: call?.name ?? "", arguments: "" },
											},
										],
									},
									null,
								),
							);
							break;
						}

						case "toolcall_delta": {
							const idx = toolIndexByContentIndex.get(event.contentIndex);
							if (idx === undefined) break;
							writeSse(
								controller,
								baseChunk({ tool_calls: [{ index: idx, function: { arguments: event.delta } }] }, null),
							);
							break;
						}

						case "done":
							finishReason =
								event.reason === "toolUse"
									? "tool_calls"
									: event.reason === "length"
										? "length"
										: hasToolCalls
											? "tool_calls"
											: "stop";
							writeSse(controller, baseChunk({}, finishReason));
							if (includeUsage) writeUsage(controller, event.message);
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
							return;

						case "error": {
							const msg = event.error.errorMessage ?? "stream error";
							writeSse(controller, { error: { message: msg, type: "upstream_error" } });
							controller.close();
							return;
						}

						// Drop start / *_start / *_end / thinking_* — chat-completions wire only
						// surfaces deltas and the terminal finish_reason.
						default:
							break;
					}
				}

				// Stream ended without a terminal `done` (defensive). Close gracefully.
				writeSse(controller, baseChunk({}, hasToolCalls ? "tool_calls" : "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				writeSse(controller, { error: { message: msg, type: "upstream_error" } });
				controller.close();
			}
		},
	});
}
