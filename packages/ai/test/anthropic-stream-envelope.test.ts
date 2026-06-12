import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { AssistantMessageEvent, Context, Model, ModelSpec, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};
const queryObjectSchema = {
	type: "object",
	properties: { query: { type: "string" } },
	required: ["query"],
};

const cityObjectSchema = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;

// Provider session state is keyed per endpoint+model (`anthropic-messages:<baseUrl>\0<id>`),
// with a legacy unscoped `anthropic-messages` key still honored. Look up the strict-tools
// flag without depending on the exact key shape.
function anthropicStrictToolsDisabled(map: Map<string, ProviderSessionState>): boolean | undefined {
	for (const [key, value] of map) {
		if (key === "anthropic-messages" || key.startsWith("anthropic-messages:")) {
			return (value as { strictToolsDisabled?: boolean }).strictToolsDisabled;
		}
	}
	return undefined;
}
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

function createMockRequest(events: MockAnthropicEvent[]): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
	};

	return {
		async withResponse() {
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}
function createRawSseRequest(frames: string[]): { asResponse(): Promise<Response> } {
	const body = new TextEncoder().encode(frames.join(""));
	return {
		async asResponse() {
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"request-id": "req_raw_mock",
				},
			});
		},
	};
}

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseRawFrame(event: string, data: string): string {
	return `event: ${event}\ndata: ${data}\n\n`;
}

function createTextSuccessSseFrames(text: string, preamble: string[] = []): string[] {
	return [...preamble, ...createTextSuccessEvents(text).map(event => sseFrame(String(event.type), event))];
}

function createRejectedMockRequest(error: Error): MockAnthropicRequest {
	return {
		async withResponse() {
			throw error;
		},
	};
}

function createStrictGrammarTooLargeError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function createOtherInvalidRequestError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Some other validation error."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function getStrictFlags(params: unknown): boolean[] {
	const tools = (params as { tools?: Array<{ strict?: unknown }> }).tools ?? [];
	return tools.map(tool => tool.strict === true);
}

function createTextSuccessEvents(
	text: string,
	options: { duplicateMessageStart?: boolean; stopReason?: string } = {},
): MockAnthropicEvent[] {
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_text_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: options.stopReason ?? "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
	if (options.duplicateMessageStart) {
		events.splice(2, 0, {
			type: "message_start",
			message: { id: "msg_duplicate", usage: { input_tokens: 99, output_tokens: 99 } },
		});
	}
	return events;
}

function createTextSuccessEventsWithPreamble(text: string, preambleEvents: MockAnthropicEvent[]): MockAnthropicEvent[] {
	return [...preambleEvents, ...createTextSuccessEvents(text)];
}

function createMalformedPreMessageStartEvents(): MockAnthropicEvent[] {
	return [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
}

function createMalformedToolUseEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool_broken",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_broken", name: "lookup_weather", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"city":"Par' },
		},
		{ type: "content_block_stop", index: 0 },
	];
}

function createUnterminatedToolUseSplicedReconnectEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool_truncated",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		// Tool call begins streaming but the transport drops before any argument
		// bytes — and before `content_block_stop` — arrive, so `arguments` is still
		// the seed `{}`.
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_truncated", name: "lookup_weather", input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
		// A transparent reconnect splices a fresh message envelope onto the same
		// stream. The duplicate `message_start` is deduped, but the orphaned tool
		// block above is never closed and the reconnect supplies the terminal stop.
		{
			type: "message_start",
			message: {
				id: "msg_reconnect",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

function countEvents(events: AssistantMessageEvent[], type: AssistantMessageEvent["type"]): number {
	return events.filter(event => event.type === type).length;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic stream envelope handling", () => {
	it("ignores duplicate message_start envelopes without resetting streamed text", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createTextSuccessEvents("hello", { duplicateMessageStart: true })) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("drops replayed closed blocks after a duplicate message_start instead of duplicating content", async () => {
		const events: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: { id: "msg_first", usage: { input_tokens: 12, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 0 },
			// A replaying proxy splices the same envelope again before the
			// terminal message_delta arrives.
			{ type: "message_start", message: { id: "msg_replay", usage: { input_tokens: 12, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 12, output_tokens: 4 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		const result = await stream.result();

		expect(countEvents(collected, "text_start")).toBe(1);
		expect(countEvents(collected, "text_end")).toBe(1);
		expect(countEvents(collected, "error")).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_first");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores ping before message_start and streams the response once", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createTextSuccessEventsWithPreamble("hello", [{ type: "ping" }])) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("maps model_context_window_exceeded to a length stop", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest(
					createTextSuccessEvents("hello", { stopReason: "model_context_window_exceeded" }),
				) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("length");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("completes the turn instead of failing when the API sends an unknown stop reason", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createTextSuccessEvents("hello", { stopReason: "weird_new_reason" })) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// The unknown reason arrives after all content streamed; it must not burn
		// a retry or surface as an error.
		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores a spliced second envelope's message_delta after the terminal stop", async () => {
		const events: MockAnthropicEvent[] = [
			...createTextSuccessEvents("hello"),
			// Transparent reconnect splices a fresh envelope onto the same stream.
			{ type: "message_start", message: { id: "msg_second", usage: { input_tokens: 99, output_tokens: 99 } } },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 99, output_tokens: 99 } },
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		const result = await stream.result();

		// The completed first envelope owns the stop reason and usage; the splice
		// must not relabel a finished turn or overwrite its counters.
		expect(countEvents(collected, "error")).toBe(0);
		expect(countEvents(collected, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.output).toBe(4);
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("tolerates envelopes missing usage and delta payloads", async () => {
		const events: MockAnthropicEvent[] = [
			{ type: "message_start", message: { id: "msg_lenient" } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0 },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta" },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		const result = await stream.result();

		// Proxies that omit usage/delta objects must degrade to anomaly logs, not
		// TypeErrors that fail the turn.
		expect(countEvents(collected, "error")).toBe(0);
		expect(countEvents(collected, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_lenient");
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
	});

	it("ignores unknown preamble events before message_start and streams the response once", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(
				createTextSuccessEventsWithPreamble("hello", [{ type: "custom_preamble_event", trace_id: "trace_123" }]),
			) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores unknown content block envelopes while preserving known blocks", async () => {
		const events: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_unknown_block",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "server_tool_use", id: "srv_1", name: "web_search" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"query":"weather"}' },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 1 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 12,
					output_tokens: 4,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const observed: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			observed.push(event);
		}
		const result = await stream.result();

		expect(countEvents(observed, "error")).toBe(0);
		expect(countEvents(observed, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_unknown_block");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("retries malformed envelopes before content starts without duplicating streamed text events", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(
				attempt === 1 ? createMalformedPreMessageStartEvents() : createTextSuccessEvents("recovered"),
			) as never;
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("retries without strict tools after Anthropic compiled grammar errors and keeps strict disabled", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			if (attempt === 1) {
				return createRejectedMockRequest(createStrictGrammarTooLargeError()) as never;
			}
			return createMockRequest(createTextSuccessEvents(attempt === 2 ? "recovered" : "later")) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(countEvents(events, "done")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false]]);
		expect(anthropicStrictToolsDisabled(providerSessionState)).toBe(true);

		const nextStream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const nextEvents: AssistantMessageEvent[] = [];
		for await (const event of nextStream) {
			nextEvents.push(event);
		}
		const nextResult = await nextStream.result();

		expect(nextResult.stopReason).toBe("stop");
		expect(nextResult.content).toEqual([{ type: "text", text: "later" }]);
		expect(countEvents(nextEvents, "done")).toBe(1);
		expect(countEvents(nextEvents, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false], [false]]);
	});

	it("does not disable strict tools for unrelated Anthropic invalid request errors", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			return createRejectedMockRequest(createOtherInvalidRequestError()) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation error");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(strictFlags).toEqual([[true]]);
		expect(anthropicStrictToolsDisabled(providerSessionState)).toBe(false);
	});

	it("finalizes a tool call with malformed argument JSON as best-effort content instead of erroring", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createMalformedToolUseEvents()) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(countEvents(events, "toolcall_delta")).toBe(1);
		expect(countEvents(events, "toolcall_end")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall content in degraded payload");
		}
		// Best-effort arguments recovered by the throttled streaming parser are retained.
		expect(toolCall.arguments).toEqual({ city: "Par" });
		expect("partialJson" in toolCall).toBe(false);
	});

	it("finalizes a tool call left open by a spliced reconnect instead of erroring", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createUnterminatedToolUseSplicedReconnectEvents()) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// Non-fatal: the unterminated tool block is finalized with its seed `{}` arguments and the
		// turn completes rather than erroring. Downstream argument validation handles the incomplete call.
		expect(attempt).toBe(1);
		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(countEvents(events, "toolcall_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(result.stopReason).toBe("stop");

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall content in degraded payload");
		}
		expect(toolCall.arguments).toEqual({});
	});
	it("parses raw SSE directly so unknown events do not fail Anthropic streams", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createRawSseRequest(
					createTextSuccessSseFrames("hello", [
						sseFrame("anthropic_internal_trace", { type: "anthropic_internal_trace", trace_id: "trace_123" }),
					]),
				) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("degrades to best-effort content when a raw SSE stream closes before message_stop", async () => {
		const incompleteFrames = createTextSuccessSseFrames("partial").filter(
			frame => !frame.includes("event: message_stop"),
		);
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createRawSseRequest(incompleteFrames) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("skips malformed raw SSE event frames and degrades to best-effort content", async () => {
		const malformedTextDelta =
			'{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"line\\qbreak"}}';
		const successEvents = createTextSuccessEvents("unused");
		const frames = [
			sseFrame("message_start", successEvents[0]),
			sseFrame("content_block_start", successEvents[1]),
			sseRawFrame("content_block_delta", malformedTextDelta),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", successEvents[4]),
			sseFrame("message_stop", { type: "message_stop" }),
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createRawSseRequest(frames) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// The unparseable content_block_delta frame is dropped; the surrounding text block streams
		// empty and the turn completes normally.
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});
	it("surfaces a refusal fallback message when stop_details is null", async () => {
		const refusalEvents: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_refusal_no_details",
					usage: {
						input_tokens: 5,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "refusal", stop_sequence: null, stop_details: null },
				usage: { input_tokens: 5, output_tokens: 0 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(refusalEvents) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({ type: "refusal" });
		expect(result.errorMessage).toContain("Refusal (no details provided)");
		expect(result.errorMessage).not.toContain("An unknown error occurred");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
	});

	it("emits per-tool eager_input_streaming only when Anthropic compat allows it", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "lookup_weather",
					description: "Lookup weather",
					parameters: cityObjectSchema,
				},
			],
		};
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		const eagerStream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test" });
		for await (const _ of eagerStream) {
			// drain stream
		}
		await eagerStream.result();

		const disabledStream = streamAnthropic(
			buildModel({
				...model,
				compat: { ...model.compatConfig, supportsEagerToolInputStreaming: false },
			} as ModelSpec<"anthropic-messages">),
			toolContext,
			{ apiKey: "sk-ant-test" },
		);
		for await (const _ of disabledStream) {
			// drain stream
		}
		await disabledStream.result();

		const eagerTool = (payloads[0] as { tools?: Array<Record<string, unknown>> }).tools?.[0];
		const disabledTool = (payloads[1] as { tools?: Array<Record<string, unknown>> }).tools?.[0];
		expect(eagerTool?.eager_input_streaming).toBe(true);
		expect(disabledTool).not.toHaveProperty("eager_input_streaming");
	});

	it("emits 1h cache TTL only for canonical Anthropic API with compatible long-cache support", async () => {
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		for (const testModel of [
			model,
			buildModel({
				...model,
				compat: { ...model.compatConfig, supportsLongCacheRetention: false },
			} as ModelSpec<"anthropic-messages">),
			buildModel({
				...model,
				baseUrl: "https://proxy.example.com/anthropic",
				compat: model.compatConfig,
			} as ModelSpec<"anthropic-messages">),
		]) {
			const stream = streamAnthropic(testModel, context, {
				apiKey: "sk-ant-test",
				cacheRetention: "long",
			});
			for await (const _ of stream) {
				// drain stream
			}
			await stream.result();
		}

		const cacheControls = payloads.map(payload => {
			const messages = (payload as { messages: Array<{ content: unknown }> }).messages;
			const content = messages.at(-1)?.content;
			if (!Array.isArray(content)) return undefined;
			return (content.at(-1) as { cache_control?: { ttl?: string; type: string } } | undefined)?.cache_control;
		});
		expect(cacheControls[0]).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		expect(cacheControls[2]).toEqual({ type: "ephemeral" });
	});
});
