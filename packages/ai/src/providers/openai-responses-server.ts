/**
 * OpenAI Responses HTTP wire-format ↔ omp Context bridge for the auth-gateway.
 *
 * Inbound: parses `POST /v1/responses` request bodies into a {@link ParsedRequest}.
 * Outbound: encodes omp's {@link AssistantMessage} (and event stream) back into
 * the documented `response.*` SSE taxonomy or the non-streaming JSON shape.
 *
 * Spec: https://platform.openai.com/docs/api-reference/responses
 * Inverse direction (source-of-truth for item shapes): ../../providers/openai-responses.ts
 *
 * Note: images and other non-text input/output parts are not emitted by this
 * encoder (omp's TextContent/ImageContent split is preserved on input but the
 * Responses format documents far more part types than we exercise here).
 */

import type { AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";

export type { ParsedRequest };

function isReasoningEffort(value: unknown): value is NonNullable<ParsedRequest["options"]["reasoning"]> {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isServiceTier(value: unknown): value is NonNullable<ParsedRequest["options"]["serviceTier"]> {
	return value === "auto" || value === "default" || value === "flex" || value === "scale" || value === "priority";
}

// ─── helpers ────────────────────────────────────────────────────────────────

function uuidNoDashes(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function makeRespId(): string {
	return `resp_${uuidNoDashes()}`;
}

function makeMsgId(): string {
	return `msg_${uuidNoDashes()}`;
}

function makeReasoningId(): string {
	return `rs_${uuidNoDashes()}`;
}

function makeFuncCallId(): string {
	return `fc_${uuidNoDashes()}`;
}

import {
	type OpenAIResponsesFunctionCallItem,
	type OpenAIResponsesFunctionCallOutputItem,
	type OpenAIResponsesInputContent,
	type OpenAIResponsesOutputContent,
	type OpenAIResponsesReasoningItem,
	type OpenAIResponsesTool,
	type OpenAIResponsesToolChoice,
	openaiResponsesRequestSchema,
} from "./openai-responses-server-schema";

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

// ─── inbound parser ─────────────────────────────────────────────────────────

function extractReasoningTextFromItem(item: OpenAIResponsesReasoningItem): string {
	const fromContent = (item.content ?? []).map(c => c.text).join("");
	if (fromContent) return fromContent;
	return (item.summary ?? []).map(c => c.text).join("");
}

function inputTextOf(blocks: OpenAIResponsesInputContent[] | string | undefined): string | TextContent[] {
	if (typeof blocks === "string") return blocks;
	if (!blocks) return [];
	const parts: TextContent[] = [];
	for (const block of blocks) {
		if (block.type === "input_text") parts.push({ type: "text", text: block.text });
	}
	return parts.length === 1 ? parts[0].text : parts;
}

function outputTextOf(blocks: OpenAIResponsesOutputContent[] | string | undefined): TextContent[] {
	if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
	if (!blocks) return [];
	const out: TextContent[] = [];
	for (const block of blocks) {
		if (block.type === "output_text") out.push({ type: "text", text: block.text });
	}
	return out;
}

function mapToolChoice(value: OpenAIResponsesToolChoice | undefined): ParsedRequest["options"]["toolChoice"] {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "none" || value === "required") return value;
	// Schema only validates ToolChoiceFunction; narrow defensively against the
	// wider SDK union (allowed/types/mcp/custom/apply_patch/shell variants).
	if ("type" in value && value.type === "function" && "name" in value) return { name: value.name };
	return undefined;
}

function buildTools(tools: Array<OpenAIResponsesTool | { type: string }> | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	const out: Tool[] = [];
	for (const t of tools) {
		// Skip non-function tools (web_search_call, file_search_call, …).
		if (t.type !== "function") continue;
		const fn = t as Extract<OpenAIResponsesTool, { type: "function" }>;
		const tool: Tool = {
			name: fn.name,
			description: fn.description ?? "",
			parameters: (fn.parameters ?? {}) as Tool["parameters"],
		};
		if (fn.strict !== undefined && fn.strict !== null) tool.strict = fn.strict;
		out.push(tool);
	}
	return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: Message[], modelId: string, now: number): AssistantMessage {
	const last = messages[messages.length - 1];
	if (last && last.role === "assistant") return last;
	const placeholder: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
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
	messages.push(placeholder);
	return placeholder;
}

export function parseRequest(body: unknown): ParsedRequest {
	const parsed = openaiResponsesRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`openai-responses: ${parsed.error.message}`);
	}
	const data = parsed.data;

	const now = Date.now();
	const messages: Message[] = [];
	const systemPrompt: string[] = [];

	if (typeof data.instructions === "string" && data.instructions.length > 0) {
		systemPrompt.push(data.instructions);
	}

	if (typeof data.input === "string") {
		messages.push({ role: "user", content: data.input, timestamp: now });
	} else if (data.input) {
		for (const item of data.input) {
			// Items may omit `type` and rely on `role` (the convenience shape).
			const effectiveType = item.type ?? ("role" in item ? "message" : undefined);
			if (effectiveType === "message") {
				const msg = item as {
					role?: string;
					content?: OpenAIResponsesInputContent[] | OpenAIResponsesOutputContent[] | string;
				};
				switch (msg.role) {
					case "system": {
						const text = inputTextOf(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						const flat = typeof text === "string" ? text : text.map(p => p.text).join("");
						if (flat.length > 0) systemPrompt.push(flat);
						break;
					}
					case "user":
					case "developer": {
						const content = inputTextOf(msg.content as OpenAIResponsesInputContent[] | string | undefined);
						messages.push({ role: msg.role, content, timestamp: now });
						break;
					}
					case "assistant": {
						const parts = outputTextOf(msg.content as OpenAIResponsesOutputContent[] | string | undefined);
						messages.push({
							role: "assistant",
							content: parts,
							api: "openai-responses",
							provider: "openai",
							model: data.model,
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
						});
						break;
					}
				}
				continue;
			}
			if (effectiveType === "reasoning") {
				const reasoning = item as OpenAIResponsesReasoningItem;
				const text = extractReasoningTextFromItem(reasoning);
				const thinking: ThinkingContent = {
					type: "thinking",
					thinking: text,
					thinkingSignature: JSON.stringify(reasoning),
					...(reasoning.id ? { itemId: reasoning.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
				continue;
			}
			if (effectiveType === "function_call") {
				const call = item as OpenAIResponsesFunctionCallItem;
				const argsRaw = call.arguments ?? "{}";
				let args: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(argsRaw);
					args = isObj(parsed) ? parsed : {};
				} catch {
					throw new Error(`openai-responses: function_call ${call.call_id} has invalid JSON arguments`);
				}
				const toolCall: ToolCall = {
					type: "toolCall",
					id: call.call_id,
					name: call.name,
					arguments: args,
					...(call.id ? { thoughtSignature: call.id } : {}),
				};
				ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
				continue;
			}
			if (effectiveType === "function_call_output") {
				const output = item as OpenAIResponsesFunctionCallOutputItem;
				// Find the matching tool call name from earlier assistant content.
				let toolName = "";
				for (let i = messages.length - 1; i >= 0; i--) {
					const m = messages[i];
					if (m.role !== "assistant") continue;
					for (const c of m.content) {
						if (c.type === "toolCall" && c.id === output.call_id) {
							toolName = c.name;
							break;
						}
					}
					if (toolName) break;
				}
				messages.push({
					role: "toolResult",
					toolCallId: output.call_id,
					toolName,
					content: [{ type: "text", text: typeof output.output === "string" ? output.output : "" }],
					isError: false,
					timestamp: now,
				});
			}
			// Other item types are tolerated but not bridged.
		}
	}

	const tools = buildTools(data.tools);
	const context: Context = {
		...(systemPrompt.length > 0 ? { systemPrompt } : {}),
		messages,
		...(tools ? { tools } : {}),
	};

	const options: ParsedRequest["options"] = {};
	if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
	if (data.temperature !== undefined) options.temperature = data.temperature;
	if (data.top_p !== undefined) options.topP = data.top_p;
	if (data.stop !== undefined && data.stop !== null) {
		options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
	}
	const toolChoice = mapToolChoice(data.tool_choice);
	if (toolChoice !== undefined) options.toolChoice = toolChoice;
	if (data.reasoning?.effort && isReasoningEffort(data.reasoning.effort)) {
		options.reasoning = data.reasoning.effort;
	}
	// OpenAI summary "auto"|"concise"|"detailed" → request a visible summary;
	// absent → leave pi-ai's default. The "none" / absence inverse maps to
	// `hideThinkingSummary: true`.
	if (data.reasoning?.summary === undefined) {
		// no-op; provider decides
	} else if (data.reasoning.summary === "none") {
		options.hideThinkingSummary = true;
	}
	if (data.service_tier !== undefined && isServiceTier(data.service_tier)) {
		options.serviceTier = data.service_tier;
	}
	if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
	// `store`, `previous_response_id`, `parallel_tool_calls` are accepted by the
	// schema for forward-compatibility but not yet plumbed through pi-ai.

	return {
		modelId: data.model,
		context,
		stream: data.stream === true,
		options,
	};
}

// ─── output item builders (shared by streaming + non-streaming encoders) ────

type ReasoningOutputItem = {
	type: "reasoning";
	id: string;
	summary: Array<{ type?: string; text?: string }>;
	content?: Array<{ type: "reasoning_text"; text: string }>;
} & Record<string, unknown>;

type OutputItem =
	| ReasoningOutputItem
	| {
			type: "message";
			id: string;
			role: "assistant";
			status: "completed";
			content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
	  }
	| { type: "function_call"; id: string; call_id: string; name: string; arguments: string; status: "completed" };

type ResponseStatus = "completed" | "in_progress" | "failed" | "incomplete";

function responseStatusForStopReason(message: AssistantMessage): ResponseStatus {
	if (message.stopReason === "length") return "incomplete";
	if (message.stopReason === "error" || message.stopReason === "aborted") return "failed";
	return "completed";
}

function buildReasoningItem(part: ThinkingContent): ReasoningOutputItem {
	if (part.thinkingSignature) {
		try {
			const parsed: unknown = JSON.parse(part.thinkingSignature);
			if (isObj(parsed) && parsed.type === "reasoning") {
				const id = part.itemId ?? asString(parsed.id) ?? makeReasoningId();
				return { ...parsed, type: "reasoning", id } as ReasoningOutputItem;
			}
		} catch {
			// Not a serialized Responses reasoning item; fall back to raw thinking text.
		}
	}
	return {
		type: "reasoning",
		id: part.itemId ?? makeReasoningId(),
		summary: [],
		content: [{ type: "reasoning_text", text: part.thinking }],
	};
}

function reasoningItemId(part: ThinkingContent): string {
	if (part.itemId) return part.itemId;
	if (part.thinkingSignature) {
		try {
			const parsed: unknown = JSON.parse(part.thinkingSignature);
			if (isObj(parsed)) {
				const id = asString(parsed.id);
				if (id) return id;
			}
		} catch {
			// Not a serialized Responses reasoning item.
		}
	}
	return makeReasoningId();
}

/**
 * Walk the assistant content array and group consecutive TextContent into a
 * single message item; each ThinkingContent / ToolCall is its own item.
 */
function buildOutputItems(message: AssistantMessage): OutputItem[] {
	const out: OutputItem[] = [];
	let pendingMessage: Extract<OutputItem, { type: "message" }> | null = null;
	const flushMessage = () => {
		if (pendingMessage) {
			out.push(pendingMessage);
			pendingMessage = null;
		}
	};

	for (const part of message.content) {
		if (part.type === "text") {
			if (!pendingMessage) {
				pendingMessage = {
					type: "message",
					id: makeMsgId(),
					role: "assistant",
					status: "completed",
					content: [],
				};
			}
			pendingMessage.content.push({ type: "output_text", text: part.text, annotations: [] });
		} else if (part.type === "thinking") {
			flushMessage();
			out.push(buildReasoningItem(part));
		} else if (part.type === "toolCall") {
			flushMessage();
			const id = part.thoughtSignature ?? makeFuncCallId();
			out.push({
				type: "function_call",
				id,
				call_id: part.id,
				name: part.name,
				arguments: JSON.stringify(part.arguments ?? {}),
				status: "completed",
			});
		}
		// RedactedThinking is silently dropped — no direct Responses wire representation.
	}
	flushMessage();
	return out;
}

function buildUsage(message: AssistantMessage): Record<string, unknown> {
	const u = message.usage;
	const inputTokens = u.input + u.cacheRead + u.cacheWrite;
	return {
		input_tokens: inputTokens,
		input_tokens_details: { cached_tokens: u.cacheRead },
		output_tokens: u.output,
		output_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
		total_tokens: inputTokens + u.output,
	};
}

function buildResponseEnvelope(
	message: AssistantMessage,
	requestedModelId: string,
	id: string,
	status: ResponseStatus,
	items: OutputItem[] | [],
	usage: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		id,
		object: "response",
		created_at: Math.floor(message.timestamp / 1000),
		status,
		model: requestedModelId,
		output: items,
		usage,
		...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
		...(status === "failed" ? { error: { message: message.errorMessage ?? "response failed" } } : {}),
	};
}

// ─── encodeResponse (non-streaming) ─────────────────────────────────────────

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const items = buildOutputItems(message);
	return buildResponseEnvelope(
		message,
		requestedModelId,
		makeRespId(),
		responseStatusForStopReason(message),
		items,
		buildUsage(message),
	);
}

// ─── encodeStream ───────────────────────────────────────────────────────────

interface OpenMessage {
	kind: "message";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	currentPartText: string;
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
}
interface OpenReasoning {
	kind: "reasoning";
	itemId: string;
	outputIndex: number;
	reasoningText: string;
}
interface OpenFunctionCall {
	kind: "function_call";
	itemId: string;
	outputIndex: number;
	callId: string;
	name: string;
	argsText: string;
}
type OpenItem = OpenMessage | OpenReasoning | OpenFunctionCall;

function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const responseId = makeRespId();
	let sequenceNumber = 0;
	const seq = () => sequenceNumber++;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (name: string, data: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq(), ...data })));
			};
			const emitDone = () => controller.enqueue(encoder.encode("data: [DONE]\n\n"));

			let createdAt = Math.floor(Date.now() / 1000);
			let outputIndex = 0;
			const state: { open: OpenItem | null } = { open: null };
			const finishedItems: OutputItem[] = [];

			const openMessage = (): OpenMessage => {
				const itemId = makeMsgId();
				const item = {
					type: "message" as const,
					id: itemId,
					status: "in_progress",
					role: "assistant" as const,
					content: [] as Array<{ type: "output_text"; text: string; annotations: never[] }>,
				};
				emit("response.output_item.added", { output_index: outputIndex, item });
				const next: OpenMessage = {
					kind: "message",
					itemId,
					outputIndex,
					contentIndex: 0,
					currentPartText: "",
					content: [],
				};
				state.open = next;
				return next;
			};

			const openReasoning = (partial: AssistantMessage, contentIndex: number): OpenReasoning => {
				const part = partial.content[contentIndex];
				const itemId = part && part.type === "thinking" ? reasoningItemId(part) : makeReasoningId();
				const item = {
					type: "reasoning" as const,
					id: itemId,
					summary: [] as never[],
					content: [] as Array<{ type: "reasoning_text"; text: string }>,
				};
				emit("response.output_item.added", { output_index: outputIndex, item });
				const next: OpenReasoning = { kind: "reasoning", itemId, outputIndex, reasoningText: "" };
				state.open = next;
				return next;
			};

			const openToolCall = (partial: AssistantMessage, contentIndex: number): OpenFunctionCall => {
				const part = partial.content[contentIndex];
				const tc = part && part.type === "toolCall" ? part : undefined;
				const itemId = tc?.thoughtSignature ?? makeFuncCallId();
				const callId = tc?.id ?? "";
				const name = tc?.name ?? "";
				const item = {
					type: "function_call" as const,
					id: itemId,
					call_id: callId,
					name,
					arguments: "",
					status: "in_progress",
				};
				emit("response.output_item.added", { output_index: outputIndex, item });
				const next: OpenFunctionCall = { kind: "function_call", itemId, outputIndex, callId, name, argsText: "" };
				state.open = next;
				return next;
			};

			const closeOpen = () => {
				if (!state.open) return;
				if (state.open.kind === "message") {
					// (No defensive part-close needed; text_end always flushes the part before
					// the next non-text event triggers closeOpen.)
					const item = {
						type: "message",
						id: state.open.itemId,
						status: "completed",
						role: "assistant",
						content: state.open.content,
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push({
						type: "message",
						id: state.open.itemId,
						role: "assistant",
						status: "completed",
						content: state.open.content,
					});
				} else if (state.open.kind === "reasoning") {
					const item = {
						type: "reasoning",
						id: state.open.itemId,
						summary: [],
						content: [{ type: "reasoning_text", text: state.open.reasoningText ?? "" }],
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push({
						type: "reasoning",
						id: state.open.itemId,
						summary: [],
						content: [{ type: "reasoning_text", text: state.open.reasoningText ?? "" }],
					});
				} else {
					const args = state.open.argsText ?? "";
					const item = {
						type: "function_call",
						id: state.open.itemId,
						call_id: state.open.callId ?? "",
						name: state.open.name ?? "",
						arguments: args,
						status: "completed",
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push({
						type: "function_call",
						id: state.open.itemId,
						call_id: state.open.callId ?? "",
						name: state.open.name ?? "",
						arguments: args,
						status: "completed",
					});
				}
				outputIndex++;
				state.open = null;
			};

			try {
				let finalMessage: AssistantMessage | null = null;
				let failureMessage: AssistantMessage | null = null;

				for await (const ev of events) {
					switch (ev.type) {
						case "start": {
							createdAt = Math.floor((ev.partial.timestamp || Date.now()) / 1000);
							controller.enqueue(
								encoder.encode(
									sseEvent("response.created", {
										type: "response.created",
										sequence_number: seq(),
										response: {
											id: responseId,
											object: "response",
											created_at: createdAt,
											status: "in_progress",
											model: requestedModelId,
											output: [],
											usage: null,
										},
									}),
								),
							);
							break;
						}
						case "text_start": {
							let cur: OpenMessage;
							if (state.open && state.open.kind === "message") {
								// continue same message item, new content part
								cur = state.open;
								cur.currentPartText = "";
							} else {
								if (state.open) closeOpen();
								cur = openMessage();
							}
							const part = { type: "output_text", text: "", annotations: [] as never[] };
							emit("response.content_part.added", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part,
							});
							break;
						}
						case "text_delta": {
							if (!state.open || state.open.kind !== "message") break;
							const cur: OpenMessage = state.open;
							cur.currentPartText += ev.delta;
							emit("response.output_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								delta: ev.delta,
								logprobs: [],
							});
							break;
						}
						case "text_end": {
							if (!state.open || state.open.kind !== "message") break;
							const cur: OpenMessage = state.open;
							const text = ev.content ?? cur.currentPartText;
							emit("response.output_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								text,
								logprobs: [],
							});
							cur.content.push({ type: "output_text", text, annotations: [] });
							emit("response.content_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part: { type: "output_text", text, annotations: [] },
							});
							cur.contentIndex += 1;
							cur.currentPartText = "";
							break;
						}
						case "thinking_start": {
							if (state.open) closeOpen();
							openReasoning(ev.partial, ev.contentIndex);
							break;
						}
						case "thinking_delta": {
							if (!state.open || state.open.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							cur.reasoningText += ev.delta;
							emit("response.reasoning_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: 0,
								delta: ev.delta,
							});
							break;
						}
						case "thinking_end": {
							if (!state.open || state.open.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							const text = ev.content ?? cur.reasoningText;
							cur.reasoningText = text;
							emit("response.reasoning_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: 0,
								text,
							});
							closeOpen();
							break;
						}
						case "toolcall_start": {
							if (state.open) closeOpen();
							openToolCall(ev.partial, ev.contentIndex);
							break;
						}
						case "toolcall_delta": {
							if (!state.open || state.open.kind !== "function_call") break;
							const cur: OpenFunctionCall = state.open;
							cur.argsText += ev.delta;
							emit("response.function_call_arguments.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								delta: ev.delta,
							});
							break;
						}
						case "toolcall_end": {
							if (!state.open || state.open.kind !== "function_call") break;
							const cur: OpenFunctionCall = state.open;
							// Finalize from the canonical ToolCall. arguments live as an object on the omp side;
							// the wire wants the JSON string the model emitted, which streamed deltas accumulated.
							const argsJson = cur.argsText || JSON.stringify(ev.toolCall.arguments ?? {});
							cur.argsText = argsJson;
							cur.callId = ev.toolCall.id;
							cur.name = ev.toolCall.name;
							if (ev.toolCall.thoughtSignature) cur.itemId = ev.toolCall.thoughtSignature;
							emit("response.function_call_arguments.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								arguments: argsJson,
								name: cur.name,
							});
							closeOpen();
							break;
						}
						case "done": {
							finalMessage = ev.message;
							break;
						}
						case "error": {
							failureMessage = ev.error;
							break;
						}
					}
				}

				if (failureMessage) {
					if (state.open) closeOpen();
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									id: responseId,
									object: "response",
									created_at: createdAt,
									status: "failed",
									model: requestedModelId,
									output: finishedItems,
									error: { message: failureMessage.errorMessage ?? "stream failed" },
								},
							}),
						),
					);
					emitDone();
					controller.close();
					return;
				}

				if (state.open) closeOpen();
				const message = finalMessage ?? ((await events.result().catch(() => null)) as AssistantMessage | null);

				// Build the canonical output from the final message so non-streaming
				// readers see the exact same shape they'd get from encodeResponse().
				const items = message ? buildOutputItems(message) : finishedItems;
				const usage = message ? buildUsage(message) : null;
				const status = message ? responseStatusForStopReason(message) : "completed";
				const terminalEvent =
					status === "incomplete"
						? "response.incomplete"
						: status === "failed"
							? "response.failed"
							: "response.completed";
				controller.enqueue(
					encoder.encode(
						sseEvent(terminalEvent, {
							type: terminalEvent,
							sequence_number: seq(),
							response: {
								id: responseId,
								object: "response",
								created_at: createdAt,
								status,
								model: requestedModelId,
								output: items,
								usage,
								...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
								...(status === "failed"
									? { error: { message: message?.errorMessage ?? "response failed" } }
									: {}),
							},
						}),
					),
				);
				emitDone();
				controller.close();
			} catch (err) {
				controller.enqueue(
					encoder.encode(
						sseEvent("response.failed", {
							type: "response.failed",
							sequence_number: seq(),
							response: {
								id: responseId,
								object: "response",
								created_at: Math.floor(Date.now() / 1000),
								status: "failed",
								model: requestedModelId,
								output: [],
								error: { message: err instanceof Error ? err.message : String(err) },
							},
						}),
					),
				);
				emitDone();
				controller.close();
			}
		},
	});
}
