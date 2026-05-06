import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, OpenAICompat } from "@oh-my-pi/pi-ai/types";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh",
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(model, testContext, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		reasoning,
		reasoningSummary: "auto",
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function customResponsesModel(compat: OpenAICompat): Model<"openai-responses"> {
	return {
		id: "deepseek-v4-flash:cloud",
		name: "deepseek-v4-flash:cloud",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		compat,
	} as Model<"openai-responses">;
}

describe("issue #931 — openai-responses reasoning effort compat mapping", () => {
	it("maps configured xhigh reasoning effort before sending Responses reasoning payload", async () => {
		const payload = await captureResponsesPayload(
			customResponsesModel({
				supportsReasoningEffort: true,
				reasoningEffortMap: {
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "max",
				},
			}),
			"xhigh",
		);

		expect(payload.reasoning).toEqual({ effort: "max", summary: "auto" });
	});
});
