import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch, fuzzyRank, resetFuzzyIndexCache } from "@oh-my-pi/pi-tui/fuzzy";

describe("fuzzyFilter", () => {
	it("does not satisfy long tokens by scattering letters across unrelated words", () => {
		const items = [
			{
				label: "Image Provider",
				text: "Image Provider providers.image openrouter Preferred provider for image generation",
			},
			{
				label: "Block Images",
				text: "Block Images images.blockImages false Prevent images from being sent to LLM providers",
			},
			{
				label: "Include Model in Prompt",
				text: "Include Model in Prompt includeModelInPrompt true Surface the active model identifier in the system prompt so the agent knows which model it is",
			},
			{
				label: "Service Tier",
				text: "Service Tier serviceTier openai-only Processing priority hint on supported providers",
			},
		];

		const results = fuzzyFilter(items, "image provider", item => item.text).map(item => item.label);

		expect(results[0]).toBe("Image Provider");
		expect(results).toContain("Block Images");
		expect(results).not.toContain("Include Model in Prompt");
		expect(results).not.toContain("Service Tier");
	});

	it("still supports short word-initial abbreviations", () => {
		const items = ["Ollama", "Kagi", "OpenCode Go", "Tavily"];

		expect(fuzzyFilter(items, "og", item => item)).toEqual(["OpenCode Go"]);
	});

	it("filters CJK queries instead of treating them as match-all", () => {
		const items = ["文件搜索", "搜索历史", "Settings"];

		expect(fuzzyFilter(items, "搜索", item => item)).toEqual(["搜索历史", "文件搜索"]);
		expect(fuzzyMatch("搜索", "Settings").matches).toBe(false);
	});
});

describe("fuzzy index cache", () => {
	it("produces identical ordering whether the cache is cold or warm", () => {
		const items = [
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
			"openai/gpt-4-turbo",
			"openai/o3",
			"anthropic/claude-3.5-sonnet",
			"anthropic/claude-4-opus",
			"google/gemini-2.5-pro",
		];
		resetFuzzyIndexCache();
		const cold = fuzzyRank(items, "gpt 4o", item => item).map(result => result.item);
		// Second pass reuses the now-cached per-text indices; the result must be byte-for-byte identical.
		const warm = fuzzyRank(items, "gpt 4o", item => item).map(result => result.item);
		expect(warm).toEqual(cold);
	});

	it("matches long candidate texts (cache bypass) deterministically", () => {
		const longText = `openai/gpt-4o ${"x".repeat(5000)}`;
		resetFuzzyIndexCache();
		const first = fuzzyMatch("gpt4", longText);
		const second = fuzzyMatch("gpt4", longText);
		expect(first).toEqual(second);
		expect(first.matches).toBe(true);
	});
});

describe("fuzzyRank empty-normalized query", () => {
	it("still calls getText for every item when the query normalizes to empty", () => {
		const seen: string[] = [];
		const items = ["alpha", "beta", "gamma"];
		const out = fuzzyRank(items, "!!!", item => {
			seen.push(item);
			return item;
		});
		// A non-blank query that normalizes to empty matches everything with score 0,
		// and must still invoke getText per item (preserving callback side effects).
		expect(seen).toEqual(items);
		expect(out.map(result => result.item)).toEqual(items);
		expect(out.every(result => result.score === 0)).toBe(true);
	});
});
