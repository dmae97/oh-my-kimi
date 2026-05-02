import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): typeof fetch {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

// Repro for https://github.com/can1357/oh-my-pi/issues/911
//
// Mistral Medium 3.5 (mistral-medium-2604) streams `delta.content` as an array of typed
// content parts (e.g. `[{ type: "text", text: "Hello" }]`) instead of a plain string.
// The OpenAI-completions stream parser passes `choice.delta.content` straight into
// `currentBlock.text += text`, which coerces the array via `String([{...}])` and produces
// the literal `[object Object]` sequence the user observes.
describe("issue #911 - Mistral Medium 3.5 array content parts", () => {
	const model: Model<"openai-completions"> = {
		...getBundledModel("mistral", "mistral-medium-2604"),
	};

	it("normalizes array-of-parts delta.content into the assembled text without [object Object]", async () => {
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-mistral-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: [{ type: "text", text: "Hello" }] },
					},
				],
			},
			{
				id: "chatcmpl-mistral-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: [{ type: "text", text: ", world" }] },
					},
				],
			},
			{
				id: "chatcmpl-mistral-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");

		expect(text).not.toContain("[object Object]");
		expect(text).toBe("Hello, world");
	});

	it("handles mixed string and array-of-parts content shapes within one stream", async () => {
		global.fetch = createMockFetch([
			{
				id: "chatcmpl-mistral-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "plain " } }],
			},
			{
				id: "chatcmpl-mistral-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: [
								{ type: "text", text: "and " },
								{ type: "text", text: "typed" },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-mistral-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");

		expect(text).not.toContain("[object Object]");
		expect(text).toBe("plain and typed");
	});
});
