import { afterEach, describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "../src/providers/anthropic";
import type { Context, Model } from "../src/types";
import { waitForDelayOrAbort } from "./helpers";

const model: Model<"anthropic-messages"> = {
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
};

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;

type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

async function waitForAbortAndThrowAbortError(signal: AbortSignal | undefined): Promise<never> {
	if (signal?.aborted) {
		throw new Error("Request was aborted.");
	}

	const { promise, reject } = Promise.withResolvers<void>();
	const onAbort = () => reject(new Error("Request was aborted."));
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await promise;
		throw new Error("Anthropic mock stream unexpectedly resumed");
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function createSuccessfulAnthropicEvents(text: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_retry_success",
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
			content_block: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
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
	];
}

function createAnthropicMockStream({
	signal,
	connectDelayMs = 0,
	events,
}: {
	signal: AbortSignal | undefined;
	connectDelayMs?: number;
	events?: MockAnthropicEvent[];
}): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			if (!events) {
				await waitForAbortAndThrowAbortError(signal);
				return;
			}
			for (const event of events) {
				yield event;
			}
		},
	};

	return {
		async withResponse() {
			if (connectDelayMs > 0) {
				await waitForDelayOrAbort(connectDelayMs, signal);
			}
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

afterEach(() => {
	// No shared globals to restore; keep hook so the suite stays explicit.
});

describe("anthropic first-event timeout retries", () => {
	it("retries when the provider never sends the first stream event", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempt === 1 ? undefined : createSuccessfulAnthropicEvents("retry recovered"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "retry recovered" }]);
		expect(result.responseId).toBe("msg_retry_success");
	});

	it("does not arm the Anthropic first-event watchdog before the stream connects", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				connectDelayMs: 30,
				events: createSuccessfulAnthropicEvents("delayed connect"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "delayed connect" }]);
	});

	it("keeps caller aborts as aborted instead of retrying them as first-event timeouts", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);

		const result = await streamAnthropic(model, context, {
			client,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 50,
		}).result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toBe("Anthropic stream timed out while waiting for the first event");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
	});
});
