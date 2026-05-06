import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "../src/model-thinking";
import { ollamaModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("ollama local provider discovery", () => {
	test("applies /api/show context and thinking capabilities to OpenAI-compatible local models", async () => {
		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/v1/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "deepseek-v4:latest", object: "model" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				expect(body.model).toBe("deepseek-v4:latest");
				return new Response(
					JSON.stringify({
						capabilities: ["completion", "tools", "thinking", "vision"],
						model_info: { "deepseek4.context_length": 1048576 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaModelManagerOptions();
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "deepseek-v4:latest");

		expect(model?.api).toBe("openai-responses");
		expect(model?.contextWindow).toBe(1048576);
		expect(model?.reasoning).toBe(true);
		expect(model?.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.High });
		expect(model?.input).toEqual(["text", "image"]);
	});
});
