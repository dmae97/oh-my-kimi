import { describe, expect, it } from "bun:test";
import { FALLBACK_DIALECT, preferredDialect } from "@oh-my-pi/pi-catalog/identity";

describe("preferredDialect", () => {
	it("maps model IDs to dialects correctly", () => {
		expect(preferredDialect("claude-3-5-sonnet-20241022")).toBe("anthropic");
		expect(preferredDialect("glm-4-flash")).toBe("glm");
		expect(preferredDialect("moonshotai/kimi-k2")).toBe("kimi");
		expect(preferredDialect("deepseek-chat")).toBe("deepseek");
		expect(preferredDialect("qwen-coder-32b-instruct")).toBe("qwen3");
		expect(preferredDialect("gpt-4o-mini")).toBe("harmony");
		expect(preferredDialect("gpt-oss-120b")).toBe("harmony");
		expect(preferredDialect("gemini-1.5-pro")).toBe("gemini");
		expect(preferredDialect("gemini-3.5-flash")).toBe("gemini");
		expect(preferredDialect("gemma-3-27b-it")).toBe("gemma");
		expect(preferredDialect("google/gemma-4-E2B-it")).toBe("gemma");
		expect(preferredDialect("unclassified-model-id")).toBe(FALLBACK_DIALECT);
	});
});
