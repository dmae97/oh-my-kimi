import { describe, expect, it } from "bun:test";
import { preferredToolSyntax } from "../src/identity/tool-syntax";

describe("preferredToolSyntax", () => {
	it("maps model IDs to syntax correctly", () => {
		expect(preferredToolSyntax("claude-3-5-sonnet-20241022")).toBe("anthropic");
		expect(preferredToolSyntax("glm-4-flash")).toBe("glm");
		expect(preferredToolSyntax("moonshotai/kimi-k2")).toBe("kimi");
		expect(preferredToolSyntax("deepseek-chat")).toBe("deepseek");
		expect(preferredToolSyntax("qwen-coder-32b-instruct")).toBe("qwen3");
		expect(preferredToolSyntax("gpt-4o-mini")).toBe("harmony");
		expect(preferredToolSyntax("gpt-oss-120b")).toBe("harmony");
		expect(preferredToolSyntax("gemini-1.5-pro")).toBe("gemini");
		expect(preferredToolSyntax("gemini-3.5-flash")).toBe("gemini");
		expect(preferredToolSyntax("gemma-3-27b-it")).toBe("gemma");
		expect(preferredToolSyntax("google/gemma-4-E2B-it")).toBe("gemma");
		expect(preferredToolSyntax("unclassified-model-id")).toBe("xml");
	});
});
