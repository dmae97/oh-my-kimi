import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.ts";

/**
 * The generator only admits OpenRouter models that advertise `tools`, because OMK drives
 * every model as a tool-calling agent. These tests pin that contract against the bundled
 * catalog so a stale or over-eager regeneration is caught without a live network call.
 */
describe("OpenRouter catalog coverage", () => {
	it("registers the Ox Alpha stealth model", () => {
		const model = getModel("openrouter", "stealth/ox-alpha");

		expect(model.name).toBe("Ox Alpha");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(131072);
	});

	it("keeps the recent frontier models reachable", () => {
		const ids = new Set(getModels("openrouter").map((model) => model.id));

		for (const id of [
			"anthropic/claude-opus-5",
			"google/gemini-3.7-flash",
			"deepseek/deepseek-v4-pro-0813",
			"qwen/qwen3.8-max",
			"x-ai/grok-4.6",
			"z-ai/glm-5.3",
			"stealth/ox-alpha",
		]) {
			expect(ids).toContain(id);
		}
	});

	it("excludes non-tool-capable image and audio endpoints", () => {
		const ids = new Set(getModels("openrouter").map((model) => model.id));

		for (const id of ["google/lyria-3-pro-preview", "google/gemini-2.5-flash-image", "openrouter/bodybuilder"]) {
			expect(ids.has(id)).toBe(false);
		}
	});

	it("gives every model a usable context and output budget", () => {
		for (const model of getModels("openrouter")) {
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
		}
	});
});
