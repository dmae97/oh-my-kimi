import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { type Context, type Model, type ModelSpec, OPENAI_MAX_OUTPUT_TOKENS } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Output-token wire policy for OpenAI-family providers:
//   - Non-aggregator completions + all responses: clamp to OPENAI_MAX_OUTPUT_TOKENS
//     (mirrors Anthropic's cap) so a catalog maxTokens that tracks the context
//     window never overflows the upstream.
//   - OpenRouter completions: omit max_tokens entirely. OpenRouter filters out any
//     upstream whose output cap is below the requested value (e.g. Cerebras GLM-4.7
//     ~40k), silently defeating provider routing. Kimi via OpenRouter is exempt
//     (it derives TPM rate limits from max_tokens).

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

afterEach(() => {
	vi.restoreAllMocks();
});

function captureResponsesBody(): { fetchMock: FetchImpl; captured: Record<string, unknown> } {
	const captured: Record<string, unknown> = {};
	const fetchMock: FetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		Object.assign(captured, body);
		const event = {
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { fetchMock, captured };
}

async function drainResponses(model: Model<"openai-responses">): Promise<Record<string, unknown>> {
	const { fetchMock, captured } = captureResponsesBody();
	const stream = streamSimple(model, ctx, { apiKey: "k", fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

function completionsSse(): Response {
	const events: unknown[] = [
		{
			id: "c",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "c",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureCompletionsBody(
	model: Model<"openai-completions">,
	maxTokens: number,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return completionsSse();
	};

	const result = await streamOpenAICompletions(model, ctx, { apiKey: "k", maxTokens, fetch: fetchMock }).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected OpenAI completions request payload");
	return payload;
}

// The OpenRouter z-ai/glm-4.7 entry that triggered the report.
function glmCompletionsModel(maxTokens: number): Model<"openai-completions"> {
	return buildModel({
		id: "z-ai/glm-4.7",
		name: "GLM 4.7",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 202_752,
		maxTokens,
	});
}

// Non-aggregator completions model: the 64k clamp applies (max_tokens is sent).
function directCompletionsModel(maxTokens: number): Model<"openai-completions"> {
	return buildModel({
		id: "glm-4.7",
		name: "GLM 4.7 (direct)",
		api: "openai-completions",
		provider: "cerebras",
		baseUrl: "https://api.cerebras.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens,
	});
}

// Kimi via OpenRouter stays exempt from the omit (TPM rate limits need max_tokens).
function kimiOpenRouterModel(maxTokens: number): Model<"openai-completions"> {
	return buildModel({
		id: "moonshotai/kimi-k2.5",
		name: "Kimi K2.5",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens,
	});
}

describe("OpenAI-family output-token cap", () => {
	it("clamps openai-responses max_output_tokens to the 64k ceiling", async () => {
		const base = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
		const model: Model<"openai-responses"> = buildModel({
			...base,
			reasoning: false,
			maxTokens: 200_000,
			compat: base.compatConfig,
		} as ModelSpec<"openai-responses">);
		const body = await drainResponses(model);
		expect(body.max_output_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});

	it("clamps non-aggregator completions output to the 64k ceiling", async () => {
		const body = await captureCompletionsBody(directCompletionsModel(131_072), 131_072);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});

	it("never raises a requested output below the ceiling", async () => {
		const body = await captureCompletionsBody(directCompletionsModel(131_072), 8_000);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(8_000);
	});

	it("respects a model maxTokens that is below the ceiling", async () => {
		const body = await captureCompletionsBody(directCompletionsModel(32_000), 131_072);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(32_000);
	});

	it("omits max_tokens entirely for OpenRouter so provider routing is not filtered", async () => {
		const body = await captureCompletionsBody(glmCompletionsModel(131_072), 131_072);
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("still sends max_tokens for Kimi via OpenRouter (TPM rate-limit requirement)", async () => {
		const body = await captureCompletionsBody(kimiOpenRouterModel(131_072), 131_072);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});
});
