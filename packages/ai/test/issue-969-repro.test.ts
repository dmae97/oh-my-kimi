import { afterEach, describe, expect, it } from "bun:test";
import { Effort, getSupportedEfforts } from "../src/model-thinking";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function customOpenAICompatModel(): Model<"openai-completions"> {
	return {
		id: "gpt-5.1",
		name: "GPT-5.1 proxy",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("issue #969 — custom thinking metadata must preserve explicit xhigh", () => {
	it("uses the configured xhigh effort for custom OpenAI-compatible models", async () => {
		const model = customOpenAICompatModel();
		let payload: Record<string, unknown> | undefined;
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
				return createSseResponse([
					{
						id: "chatcmpl-969",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: "ok" } }],
					},
					{
						id: "chatcmpl-969",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]);
			},
			{ preconnect: originalFetch.preconnect },
		);

		expect(getSupportedEfforts(model)).toContain(Effort.XHigh);
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(payload?.reasoning_effort).toBe("xhigh");
	});
});
