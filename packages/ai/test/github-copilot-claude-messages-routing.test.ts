import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";

describe("Copilot Claude model routing", () => {
	it("routes claude-sonnet-4 via anthropic-messages API", () => {
		const model = getBundledModel("github-copilot", "claude-sonnet-4");
		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
	});

	it("routes claude-sonnet-4.5 via anthropic-messages API", () => {
		const model = getBundledModel("github-copilot", "claude-sonnet-4.5");
		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
	});

	it("routes claude-haiku-4.5 via anthropic-messages API", () => {
		const model = getBundledModel("github-copilot", "claude-haiku-4.5");
		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
	});

	it("routes claude-opus-4.5 via anthropic-messages API", () => {
		const model = getBundledModel("github-copilot", "claude-opus-4.5");
		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
	});

	it("does not have compat block on Claude models (completions-API-specific)", () => {
		const sonnet = getBundledModel("github-copilot", "claude-sonnet-4");
		expect("compat" in sonnet).toBe(false);
	});

	it("preserves static Copilot headers on Claude models", () => {
		const model = getBundledModel("github-copilot", "claude-sonnet-4");
		expect(model.headers).toBeDefined();
		expect(model.headers?.["User-Agent"]).toContain("opencode");
	});

	it("keeps non-Claude Copilot models on their existing APIs", () => {
		const gpt4o = getBundledModel("github-copilot", "gpt-4o");
		expect(gpt4o).toBeDefined();
		expect(gpt4o.api).toBe("openai-completions");

		const gpt5 = getBundledModel("github-copilot", "gpt-5");
		expect(gpt5).toBeDefined();
		expect(gpt5.api).toBe("openai-responses");
	});
});
