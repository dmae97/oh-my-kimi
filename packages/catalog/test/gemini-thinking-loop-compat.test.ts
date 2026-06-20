import { describe, expect, it } from "bun:test";
import { buildOpenAICompat, buildOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog/compat/openai";
import type { ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog/types";

/**
 * The pi-ai thinking-loop guard is gemini-only and, for `openai-completions`
 * models, gates on `compat.enableGeminiThinkingLoopGuard`. `buildOpenAICompat`
 * must default that flag from the family classifier and honor explicit
 * overrides so an opaque OpenAI-compat proxy alias can opt in/out.
 */
function spec(id: string, compat?: OpenAICompat): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id,
		name: id,
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 32_000,
		contextWindow: 200_000,
		reasoning: true,
		...(compat ? { compat } : {}),
	};
}

describe("buildOpenAICompat enableGeminiThinkingLoopGuard", () => {
	it("defaults on for gemini-family ids, including aggregator namespaces", () => {
		expect(buildOpenAICompat(spec("gemini-3.5-flash")).enableGeminiThinkingLoopGuard).toBe(true);
		expect(buildOpenAICompat(spec("google/gemini-3-pro")).enableGeminiThinkingLoopGuard).toBe(true);
	});

	it("defaults off for non-gemini ids (incl. gemma lookalikes)", () => {
		expect(buildOpenAICompat(spec("gpt-5.5")).enableGeminiThinkingLoopGuard).toBe(false);
		expect(buildOpenAICompat(spec("gemma-3-1b")).enableGeminiThinkingLoopGuard).toBe(false);
	});

	it("lets an opaque proxy alias opt in via explicit compat override", () => {
		const compat = buildOpenAICompat(spec("my-fast-model", { enableGeminiThinkingLoopGuard: true }));
		expect(compat.enableGeminiThinkingLoopGuard).toBe(true);
	});

	it("lets a gemini-family id opt out via explicit compat override", () => {
		const compat = buildOpenAICompat(spec("gemini-3.5-flash", { enableGeminiThinkingLoopGuard: false }));
		expect(compat.enableGeminiThinkingLoopGuard).toBe(false);
	});
});

describe("buildOpenAIResponsesCompat enableGeminiThinkingLoopGuard", () => {
	const responsesSpec = (id: string, compat?: OpenAICompat) => ({
		id,
		name: id,
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		...(compat ? { compat } : {}),
	});

	it("defaults from the family classifier", () => {
		expect(buildOpenAIResponsesCompat(responsesSpec("gemini-3-pro")).enableGeminiThinkingLoopGuard).toBe(true);
		expect(buildOpenAIResponsesCompat(responsesSpec("gpt-5.5")).enableGeminiThinkingLoopGuard).toBe(false);
	});

	it("honors an explicit override for an opaque proxy alias", () => {
		expect(
			buildOpenAIResponsesCompat(responsesSpec("my-fast-model", { enableGeminiThinkingLoopGuard: true }))
				.enableGeminiThinkingLoopGuard,
		).toBe(true);
	});
});
