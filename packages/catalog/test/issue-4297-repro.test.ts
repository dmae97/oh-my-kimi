import { describe, expect, it } from "bun:test";
import { buildAnthropicCompat } from "../src/compat/anthropic";
import type { ModelSpec } from "../src/types";

function spec(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "anthropic--claude-4.6-opus",
		name: "Claude 4.6 Opus via proxy",
		provider: "my-proxy",
		baseUrl: "http://localhost:6655/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("#4297 custom anthropic-messages provider signing default", () => {
	it("demotes unsigned thinking for custom Claude proxy providers by default", () => {
		expect(buildAnthropicCompat(spec()).replayUnsignedThinking).toBe(false);
	});

	it("allows non-signing custom providers to opt into replaying unsigned thinking", () => {
		expect(buildAnthropicCompat(spec({ compat: { replayUnsignedThinking: true } })).replayUnsignedThinking).toBe(
			true,
		);
	});
});
