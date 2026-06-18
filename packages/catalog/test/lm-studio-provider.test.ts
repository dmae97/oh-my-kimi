import { describe, expect, test, vi } from "bun:test";
import { lmStudioModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("lm studio local provider discovery", () => {
	test("marks native VLM models as image-capable", async () => {
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "qwen/qwen3.6-27b",
								type: "vlm",
								capabilities: ["tool_use"],
								max_context_length: 262144,
							},
							{ id: "plain-llm", type: "llm" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "qwen/qwen3.6-27b", object: "model" },
							{ id: "plain-llm", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const vision = models?.find(model => model.id === "qwen/qwen3.6-27b");
		const text = models?.find(model => model.id === "plain-llm");

		expect(requestedUrls).toContain("http://127.0.0.1:1234/api/v0/models");
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.contextWindow).toBe(262144);
		expect(text?.input).toEqual(["text"]);
	});
});
