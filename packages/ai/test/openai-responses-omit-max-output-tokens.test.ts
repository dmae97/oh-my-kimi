import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamSimple } from "../src/stream";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;

function mockSseFetch(): Record<string, unknown> {
	const captured: Record<string, unknown> = {};
	const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		Object.assign(captured, body);
		const event = {
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
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;
	return captured;
}

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

async function drain(model: Model<"openai-responses">): Promise<Record<string, unknown>> {
	const captured = mockSseFetch();
	const stream = streamSimple(model, ctx, { apiKey: "k" });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

beforeEach(() => {
	expect(baseModel.maxTokens).toBeGreaterThan(0);
});

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("openai-responses max_output_tokens opt-out", () => {
	it("sends max_output_tokens = model.maxTokens by default", async () => {
		const body = await drain(baseModel);
		expect(body.max_output_tokens).toBe(baseModel.maxTokens);
	});

	it("omits max_output_tokens when model.omitMaxOutputTokens is true", async () => {
		const model: Model<"openai-responses"> = { ...baseModel, omitMaxOutputTokens: true };
		const body = await drain(model);
		expect(body).not.toHaveProperty("max_output_tokens");
		// maxTokens is still populated locally for budgeting, even though we
		// don't put it on the wire.
		expect(model.maxTokens).toBe(baseModel.maxTokens);
	});
});
