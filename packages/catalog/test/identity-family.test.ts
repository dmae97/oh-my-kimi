import { describe, expect, test } from "bun:test";
import {
	isClaudeModelId,
	isKimiK26ModelId,
	isKimiModelId,
	supportsAdaptiveThinkingDisplay,
} from "@oh-my-pi/pi-catalog/identity";

describe("isKimiModelId", () => {
	test("matches Kimi namespace and delimiter forms", () => {
		expect(isKimiModelId("moonshotai/kimi-k2")).toBe(true);
		expect(isKimiModelId("kimi-k2.6")).toBe(true);
		expect(isKimiModelId("vendor/kimi.x")).toBe(true);
		expect(isKimiModelId("akimbo-model")).toBe(false);
	});
});

describe("isKimiK26ModelId", () => {
	test("matches Kimi K2.6 without accepting adjacent versions", () => {
		expect(isKimiK26ModelId("kimi-k2.6")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2.6-thinking")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2.61")).toBe(false);
		expect(isKimiK26ModelId("kimi-k2.5")).toBe(false);
	});
});

describe("isClaudeModelId", () => {
	test("matches Claude namespace and delimiter forms", () => {
		expect(isClaudeModelId("claude-sonnet-4-6")).toBe(true);
		expect(isClaudeModelId("anthropic/claude.3")).toBe(true);
		expect(isClaudeModelId("my-claudius")).toBe(false);
	});
});

describe("supportsAdaptiveThinkingDisplay", () => {
	test("allows Claude Fable 5 and Opus 4.7 or newer only", () => {
		expect(supportsAdaptiveThinkingDisplay("claude-fable-5")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4-7")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-5-0")).toBe(true);
		// Dotted and dashed version separators are equivalent.
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4.7")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("anthropic/claude-opus-4.8")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4-6")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4.6")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4-20250514")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-sonnet-4-6")).toBe(false);
	});
});
