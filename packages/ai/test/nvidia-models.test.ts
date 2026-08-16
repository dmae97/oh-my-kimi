import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const response = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							};
						},
					};
					const promise = Promise.resolve(response) as Promise<typeof response> & {
						withResponse: () => Promise<{
							data: typeof response;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: response,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("NVIDIA models", () => {
	it("registers GLM-5.2 on the NVIDIA OpenAI-compatible endpoint", () => {
		const model = getModel("nvidia", "z-ai/glm-5.2");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap?.max).toBe("max");
		expect(model.compat).toMatchObject({
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
		});
	});

	it("sends max thinking as reasoning_effort with max_tokens", async () => {
		const model = getModel("nvidia", "z-ai/glm-5.2");
		let payload: unknown;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Think carefully.", timestamp: Date.now() }] },
			{
				apiKey: "test",
				reasoning: "max",
				maxTokens: 4096,
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			reasoning_effort?: string;
			max_tokens?: number;
			max_completion_tokens?: number;
		};
		expect(params.reasoning_effort).toBe("max");
		expect(params.max_tokens).toBe(4096);
		expect(params.max_completion_tokens).toBeUndefined();
	});
});
