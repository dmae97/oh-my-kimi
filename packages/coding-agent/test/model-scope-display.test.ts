import { describe, expect, it } from "bun:test";
import { formatModelScopeList } from "../src/model-scope-display";

describe("formatModelScopeList", () => {
	it("omits thinking suffixes when unset and includes explicit levels", () => {
		const modelList = formatModelScopeList([
			{ model: { id: "openai/gpt-5.5" } },
			{ model: { id: "anthropic/claude-opus-4.8" }, thinkingLevel: "high" },
		]);

		expect(modelList).toBe("openai/gpt-5.5, anthropic/claude-opus-4.8:high");
		expect(modelList).not.toContain(":undefined");
	});
});
