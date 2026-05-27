import { afterEach, describe, expect, it, vi } from "bun:test";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { streamAnthropic } from "../src/providers/anthropic";
import type { AssistantMessageEvent, Context, Model, ThinkingContent } from "../src/types";

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
	messages: [{ role: "user", content: "Think step by step.", timestamp: Date.now() }],
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
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function thinkingStreamEvents(thinkingChunks: string[], signature: string, trailingText: string): MockAnthropicEvent[] {
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_thinking",
				usage: {
					input_tokens: 4,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
	];
	for (const chunk of thinkingChunks) {
		events.push({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: chunk },
		});
	}
	events.push({
		type: "content_block_delta",
		index: 0,
		delta: { type: "signature_delta", signature },
	});
	events.push({ type: "content_block_stop", index: 0 });
	events.push({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
	events.push({
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: trailingText },
	});
	events.push({ type: "content_block_stop", index: 1 });
	events.push({
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 4, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	});
	events.push({ type: "message_stop" });
	return events;
}

async function runStream(events: MockAnthropicEvent[]): Promise<{
	events: AssistantMessageEvent[];
	thinking: ThinkingContent;
}> {
	vi.spyOn(Messages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);
	const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
	const collected: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		collected.push(event);
	}
	const result = await stream.result();
	const thinking = result.content.find((c): c is ThinkingContent => c.type === "thinking");
	if (!thinking) throw new Error("Expected thinking content in result");
	return { events: collected, thinking };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic thinking filter — rewritten-thinking meta-prompt", () => {
	it("collapses a thinking block whose mid-stream content reveals the marker", async () => {
		// Marker appears after a short preamble — first delta is innocuous, second carries
		// the meta-prompt phrase. The remainder of the broken summary should never reach
		// downstream consumers.
		const events = thinkingStreamEvents(
			[
				"I don't see any current ",
				"rewritten thinking or next thinking to process. ",
				"Could you provide the next thinking that needs to be rewritten?",
			],
			"sig_broken",
			"final answer",
		);
		const { events: emitted, thinking } = await runStream(events);

		expect(thinking.thinking).toBe("Thinking...");
		expect(thinking.thinkingSignature).toBe("");

		// First delta (pre-marker) is the only thinking_delta that should have been emitted.
		const thinkingDeltas = emitted.filter(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_delta" }> => e.type === "thinking_delta",
		);
		expect(thinkingDeltas.map(d => d.delta)).toEqual(["I don't see any current "]);

		// thinking_end carries the replacement content so any downstream renderer
		// re-rendering from the final event reflects "Thinking...".
		const thinkingEnd = emitted.find(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_end" }> => e.type === "thinking_end",
		);
		expect(thinkingEnd?.content).toBe("Thinking...");

		// Trailing assistant text is preserved untouched.
		const text = emitted.find(
			(e): e is Extract<AssistantMessageEvent, { type: "text_end" }> => e.type === "text_end",
		);
		expect(text?.content).toBe("final answer");
	});

	it("collapses a thinking block whose marker only becomes apparent at content_block_stop", async () => {
		// Single delta carries the entire broken summary — detection happens on stop.
		const events = thinkingStreamEvents(
			["A complete rewritten thinking explanation in one chunk."],
			"sig_late_marker",
			"answer",
		);
		const { events: emitted, thinking } = await runStream(events);

		expect(thinking.thinking).toBe("Thinking...");
		expect(thinking.thinkingSignature).toBe("");

		const thinkingEnd = emitted.find(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_end" }> => e.type === "thinking_end",
		);
		expect(thinkingEnd?.content).toBe("Thinking...");
	});

	it("leaves legitimate thinking blocks untouched (no marker, signature retained)", async () => {
		const events = thinkingStreamEvents(
			["Considering the inputs, the user wants ", "a step-by-step plan."],
			"sig_ok",
			"plan: do X",
		);
		const { events: emitted, thinking } = await runStream(events);

		expect(thinking.thinking).toBe("Considering the inputs, the user wants a step-by-step plan.");
		expect(thinking.thinkingSignature).toBe("sig_ok");

		const thinkingDeltas = emitted.filter(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_delta" }> => e.type === "thinking_delta",
		);
		expect(thinkingDeltas.map(d => d.delta)).toEqual([
			"Considering the inputs, the user wants ",
			"a step-by-step plan.",
		]);

		const thinkingEnd = emitted.find(
			(e): e is Extract<AssistantMessageEvent, { type: "thinking_end" }> => e.type === "thinking_end",
		);
		expect(thinkingEnd?.content).toBe("Considering the inputs, the user wants a step-by-step plan.");
	});
});
