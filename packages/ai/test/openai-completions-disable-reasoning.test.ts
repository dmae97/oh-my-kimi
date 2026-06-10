import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

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

function createReasoningEffortModel(): Model<"openai-completions"> {
	return buildModel({
		id: "minimal-reasoner",
		name: "Minimal Reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createFireworksReasoningEffortModel(): Model<"openai-completions"> {
	const base = createReasoningEffortModel();
	return buildModel({
		...base,
		id: "glm-5.1",
		name: "GLM 5.1",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

async function captureDisableReasoningPayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([
				{
					id: "chatcmpl-disable-reasoning",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "ok" } }],
				},
				{
					id: "chatcmpl-disable-reasoning",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: fetch.preconnect },
	);

	const result = await streamOpenAICompletions(model, testContext, {
		apiKey: "test-key",
		fetch: fetchMock,
		disableReasoning: true,
	}).result();

	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected OpenAI completions request payload");
	return payload;
}

describe("OpenAI completions disableReasoning", () => {
	it("sends the lowest supported reasoning effort for generic effort-mode models", async () => {
		const payload = await captureDisableReasoningPayload(createReasoningEffortModel());

		expect(payload.reasoning_effort).toBe("minimal");
		expect(payload.reasoning).toBeUndefined();
	});

	it("maps Fireworks' lowest effort to the provider-supported none literal", async () => {
		const payload = await captureDisableReasoningPayload(createFireworksReasoningEffortModel());

		expect(payload.reasoning_effort).toBe("none");
		expect(payload.reasoning).toBeUndefined();
	});
});
