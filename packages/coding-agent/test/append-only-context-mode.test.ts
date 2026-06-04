import { describe, expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";

const XIAOMI_TOKEN_PLAN_ANTHROPIC = {
	provider: "xiaomi-token-plan-sgp",
	baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
};

const GENERIC_PROXY = {
	provider: "generic-proxy",
	baseUrl: "https://llm.example.com/v1",
};

describe("shouldEnableAppendOnlyContext", () => {
	test("honors explicit on and off settings", () => {
		expect(shouldEnableAppendOnlyContext("on", GENERIC_PROXY)).toBe(true);
		expect(shouldEnableAppendOnlyContext("off", { provider: "deepseek", baseUrl: "https://api.deepseek.com" })).toBe(
			false,
		);
	});

	test("auto enables for DeepSeek", () => {
		expect(shouldEnableAppendOnlyContext("auto", { provider: "deepseek", baseUrl: "https://api.deepseek.com" })).toBe(
			true,
		);
	});

	test("auto enables for Xiaomi Token Plan SGLang HiCache endpoints", () => {
		expect(shouldEnableAppendOnlyContext("auto", XIAOMI_TOKEN_PLAN_ANTHROPIC)).toBe(true);
	});

	test("auto enables when model compat explicitly supports stored requests", () => {
		expect(
			shouldEnableAppendOnlyContext("auto", {
				...GENERIC_PROXY,
				compat: { supportsStore: true },
			}),
		).toBe(true);
	});

	test("auto remains off for unknown providers without prefix-cache signals", () => {
		expect(shouldEnableAppendOnlyContext("auto", GENERIC_PROXY)).toBe(false);
	});
});
