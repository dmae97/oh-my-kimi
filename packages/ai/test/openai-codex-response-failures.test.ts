import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 372000,
	maxTokens: 128000,
};

const context: Context = {
	messages: [{ role: "user", content: "Analyze this.", timestamp: 0 }],
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function sseResponse(text: string): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function toolCallSseResponse(): Response {
	const argumentsJson = JSON.stringify({ path: "README.md" });
	const events = [
		{
			type: "response.output_item.added",
			item: {
				type: "function_call",
				id: "fc_test",
				call_id: "call_test",
				name: "read",
				arguments: "",
			},
		},
		{ type: "response.function_call_arguments.delta", delta: argumentsJson },
		{ type: "response.function_call_arguments.done", arguments: argumentsJson },
		{
			type: "response.output_item.done",
			item: {
				type: "function_call",
				id: "fc_test",
				call_id: "call_test",
				name: "read",
				arguments: argumentsJson,
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("OpenAI Codex response failures", () => {
	it("preserves usage reported by response.failed", async () => {
		const failed = {
			type: "response.failed",
			response: {
				status: "failed",
				error: { code: "bad_request", message: "upstream failed" },
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(`data: ${JSON.stringify(failed)}\n\n`, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("upstream failed");
		expect(result.usage).toMatchObject({ input: 5, output: 3, totalTokens: 8 });
	});

	it.each([200, 500])("cancels a status %i response body when onResponse rejects", async (status) => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status, headers: { "content-type": "text/event-stream" } })),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			onResponse: async () => {
				throw new Error("observer failed");
			},
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("observer failed");
		expect(cancelled).toBe(true);
	});

	it.each(["delta", "terminal"] as const)(
		"cancels an open synthesis body when the internal %s cap is reached",
		async (mode) => {
			let requests = 0;
			let cancelled = false;
			const encoder = new TextEncoder();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					requests++;
					if (requests <= 2) return sseResponse("analysis");
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							const text = "S".repeat(130000);
							const events = [
								{
									type: "response.output_item.added",
									item: {
										type: "message",
										id: "msg_1",
										role: "assistant",
										status: "in_progress",
										content: [],
									},
								},
								{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
								mode === "delta"
									? { type: "response.output_text.delta", delta: text }
									: {
											type: "response.output_item.done",
											item: {
												type: "message",
												id: "msg_1",
												role: "assistant",
												status: "completed",
												content: [{ type: "output_text", text }],
											},
										},
							];
							controller.enqueue(
								encoder.encode(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`),
							);
						},
						cancel() {
							cancelled = true;
						},
					});
					return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
				}),
			);

			const result = await streamOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-moa"), context, {
				apiKey: mockToken(),
				transport: "sse",
			}).result();
			const text = result.content.find((content) => content.type === "text");

			expect(cancelled).toBe(true);
			expect(text?.text).toHaveLength(128000);
			expect(result.stopReason).toBe("length");
		},
	);

	it("forwards synthesis tool-call events to the agent loop", async () => {
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests++;
				return requests <= 2 ? sseResponse("analysis") : toolCallSseResponse();
			}),
		);

		const stream = streamOpenAICodexResponses(
			getModel("openai-codex", "gpt-5.6-moa"),
			{
				...context,
				tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
			},
			{ apiKey: mockToken(), transport: "sse" },
		);
		const toolEvents: string[] = [];
		for await (const event of stream) {
			if (event.type.startsWith("toolcall_")) toolEvents.push(event.type);
		}
		const result = await stream.result();

		expect(toolEvents).toEqual(["toolcall_start", "toolcall_delta", "toolcall_end"]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_test|fc_test",
			name: "read",
			arguments: { path: "README.md" },
		});
	});

	it("removes retry sleep abort listeners after a successful delay", async () => {
		let requests = 0;
		const controller = new AbortController();
		const addListener = vi.spyOn(controller.signal, "addEventListener");
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests++;
				return requests === 1
					? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
					: sseResponse("ok");
			}),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			maxRetries: 1,
			signal: controller.signal,
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toBe(2);
		expect(removeListener.mock.calls).toHaveLength(addListener.mock.calls.length);
	});

	it("extracts nested code/message from bare type=error events", async () => {
		// Codex emits context_length_exceeded as a bare `type:"error"` SSE event
		// with the real fields nested under `error` — not at the top level.
		const errorEvent = {
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "context_length_exceeded",
				message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
				param: "input",
			},
			sequence_number: 2,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(`data: ${JSON.stringify(errorEvent)}\n\n`, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			),
		);

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Your input exceeds the context window of this model.");
		expect(result.errorMessage).toContain("context_length_exceeded");
		expect(result.errorMessage).not.toContain('"type"');
	});
});
