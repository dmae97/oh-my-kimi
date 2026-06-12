import { describe, expect, it } from "bun:test";
import { formatModelScopeList } from "../src/model-scope-display";

describe("formatModelScopeList", () => {
	it("omits thinking suffixes when unset and includes explicit levels", () => {
		const modelList = formatModelScopeList([
			{ model: { id: "openai/gpt-5.5" }, explicitThinkingLevel: false },
			{ model: { id: "anthropic/claude-opus-4.8" }, thinkingLevel: "high", explicitThinkingLevel: true },
		]);

		expect(modelList).toBe("openai/gpt-5.5, anthropic/claude-opus-4.8:high");
		expect(modelList).not.toContain(":undefined");
	});

	it("hides the suffix when the level was filled from the global default", () => {
		// `applyRootSessionOptions` fills `sessionOptions.scopedModels[*].thinkingLevel`
		// with the global default for Ctrl+P cycling — the banner must not surface that
		// default as if the user had scoped `:high`.
		const modelList = formatModelScopeList([
			{ model: { id: "openai/gpt-5.5" }, thinkingLevel: "high", explicitThinkingLevel: false },
		]);

		expect(modelList).toBe("openai/gpt-5.5");
	});
});
