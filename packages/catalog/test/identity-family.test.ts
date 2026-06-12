import { describe, expect, test } from "bun:test";
import {
	isClaudeModelId,
	isKimiK26ModelId,
	isKimiModelId,
	isMinimaxM2FamilyModelId,
	isOpenAIGptOssModelId,
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
		// Router ids spell the version `k2p6` (e.g. Fireworks Fire Pass).
		expect(isKimiK26ModelId("accounts/fireworks/routers/kimi-k2p6-turbo")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2p6")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2p61")).toBe(false);
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

describe("isMinimaxM2FamilyModelId", () => {
	test("matches every M2-generation id shape served by aggregator/native hosts", () => {
		// Fireworks/OpenCode/openrouter direct ids and `-highspeed`/`-lightning` variants.
		expect(isMinimaxM2FamilyModelId("minimax-m2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("MiniMax-M2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("MiniMax-M2.7-highspeed")).toBe(true);
		expect(isMinimaxM2FamilyModelId("MiniMax-M2.1-lightning")).toBe(true);
		// Vendor-namespaced ids on aggregators.
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m2")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m2.5:free")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimaxai/minimax-m2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m2-her")).toBe(true);
		// Bedrock-shaped id and aimlapi short form.
		expect(isMinimaxM2FamilyModelId("minimax.minimax-m2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/m2")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/m2-7-highspeed")).toBe(true);
		// Venice's dotless aliases.
		expect(isMinimaxM2FamilyModelId("minimax-m21")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax-m25")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax-m27")).toBe(true);
	});

	test("excludes non-M2 MiniMax SKUs and unrelated families", () => {
		expect(isMinimaxM2FamilyModelId("minimax/m1")).toBe(false);
		expect(isMinimaxM2FamilyModelId("MiniMax-M1")).toBe(false);
		expect(isMinimaxM2FamilyModelId("MiniMax-M3")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m3")).toBe(false);
		expect(isMinimaxM2FamilyModelId("MiniMax-Text-01")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax-music")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax/hailuo-02")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax/music-2.0")).toBe(false);
		// Lone "m2" string with no MiniMax context does not match.
		expect(isMinimaxM2FamilyModelId("kimi-m2")).toBe(false);
		expect(isMinimaxM2FamilyModelId("gpt-oss-120b")).toBe(false);
	});
});

describe("isOpenAIGptOssModelId", () => {
	test("matches gpt-oss across catalog id shapes", () => {
		expect(isOpenAIGptOssModelId("gpt-oss-120b")).toBe(true);
		expect(isOpenAIGptOssModelId("gpt-oss-20b")).toBe(true);
		expect(isOpenAIGptOssModelId("gpt-oss:120b")).toBe(true);
		expect(isOpenAIGptOssModelId("openai/gpt-oss-120b")).toBe(true);
		expect(isOpenAIGptOssModelId("gpt-oss-120b-medium")).toBe(true);
	});

	test("excludes unrelated `gpt-*` and `oss` models", () => {
		expect(isOpenAIGptOssModelId("gpt-4o")).toBe(false);
		expect(isOpenAIGptOssModelId("gpt-4.1-mini")).toBe(false);
		expect(isOpenAIGptOssModelId("oss-llm")).toBe(false);
		expect(isOpenAIGptOssModelId("MiniMax-M2.7")).toBe(false);
	});
});
