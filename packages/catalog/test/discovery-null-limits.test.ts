import { describe, expect, it } from "bun:test";
import { fetchOpenAICompatibleModels } from "../src/discovery/openai-compatible";

describe("discovery null limits", () => {
	it("emits null for contextWindow and maxTokens when limits are unknown", async () => {
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "some-model",
							name: "Some Model",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const models = await fetchOpenAICompatibleModels({
			provider: "custom",
			api: "openai-completions",
			baseUrl: "https://api.example.com/v1",
			fetch: mockFetch,
		});

		expect(models).toBeDefined();
		expect(models!.length).toBe(1);
		expect(models![0].contextWindow).toBeNull();
		expect(models![0].maxTokens).toBeNull();
	});
});
