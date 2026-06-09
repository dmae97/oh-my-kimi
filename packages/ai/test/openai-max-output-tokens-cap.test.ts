import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { OPENAI_MAX_OUTPUT_TOKENS, type Context, type Model } from "@oh-my-pi/pi-ai/types";

// Regression for the OpenRouter -> Cerebras GLM-4.7 overflow: the catalog
// `maxTokens` (131072) reflected the model's window, not the Cerebras upstream's
// per-request limit, so omp requested the full ceiling as output and 400'd.
// Output is now clamped to OPENAI_MAX_OUTPUT_TOKENS (mirroring Anthropic's cap)
// across both OpenAI-family wires: responses (applyCommonResponsesSamplingParams)
// and completions (streamOpenAICompletions).

const originalFetch = global.fetch;

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function captureResponsesBody(): Record<string, unknown> {
	const captured: Record<string, unknown> = {};
	const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;
	return captured;
}

async function drainResponses(model: Model<"openai-responses">): Promise<Record<string, unknown>> {
	const captured = captureResponsesBody();
	const stream = streamSimple(model, ctx, { apiKey: "k" });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

function completionsSse(): Response {
	const events: unknown[] = [
		{ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "ok" } }] },
		{ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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
	global.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return completionsSse();
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;

	const result = await streamOpenAICompletions(model, ctx, { apiKey: "k", maxTokens }).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected OpenAI completions request payload");
	return payload;
}

// The OpenRouter z-ai/glm-4.7 entry that triggered the report.
function glmCompletionsModel(maxTokens: number): Model<"openai-completions"> {
	return {
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
	};
}

describe("OpenAI-family output-token cap", () => {
	it("clamps openai-responses max_output_tokens to the 64k ceiling", async () => {
		const model: Model<"openai-responses"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">),
			reasoning: false,
			maxTokens: 200_000,
		};
		const body = await drainResponses(model);
		expect(body.max_output_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});

	it("clamps openai-completions output tokens to the 64k ceiling (OpenRouter GLM-4.7 repro)", async () => {
		const body = await captureCompletionsBody(glmCompletionsModel(131_072), 131_072);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});

	it("never raises a requested output below the ceiling", async () => {
		const body = await captureCompletionsBody(glmCompletionsModel(131_072), 8_000);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(8_000);
	});

	it("respects a model maxTokens that is below the ceiling", async () => {
		const body = await captureCompletionsBody(glmCompletionsModel(32_000), 131_072);
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(32_000);
	});
});
