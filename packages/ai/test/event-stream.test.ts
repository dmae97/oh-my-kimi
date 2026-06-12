import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

function createPartial(text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("AssistantMessageEventStream", () => {
	it("queues adjacent delta events immediately without throttling or merging", () => {
		const stream = new AssistantMessageEventStream();

		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: createPartial("a") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial: createPartial("ab") });

		expect(stream.queue).toHaveLength(2);
		expect(stream.queue[0]).toMatchObject({ type: "text_delta", delta: "a" });
		expect(stream.queue[1]).toMatchObject({ type: "text_delta", delta: "b" });
	});

	it("rejects result() when ended without a terminal value", async () => {
		const stream = new AssistantMessageEventStream();
		stream.end();
		await expect(stream.result()).rejects.toThrow(/ended without a final result/);
	});

	it("keeps the pushed terminal result when end() follows a done event", async () => {
		const stream = new AssistantMessageEventStream();
		const message = createPartial("final");
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
		await expect(stream.result()).resolves.toBe(message);
	});
});
