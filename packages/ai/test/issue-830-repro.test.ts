import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import type { OpenAICompat } from "../src/types";

describe("deepseek built-in provider (issue #830)", () => {
	test("registers built-in runtime descriptor with DEEPSEEK_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepseek");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-v4-pro");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("DEEPSEEK_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.deepseek).toBe("deepseek-v4-pro");
	});

	test("resolves DEEPSEEK_API_KEY via env", () => {
		const previous = Bun.env.DEEPSEEK_API_KEY;
		Bun.env.DEEPSEEK_API_KEY = "deepseek-test-key";
		try {
			expect(getEnvApiKey("deepseek")).toBe("deepseek-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.DEEPSEEK_API_KEY;
			} else {
				Bun.env.DEEPSEEK_API_KEY = previous;
			}
		}
	});

	test("models.dev mapping descriptor uses api.deepseek.com and forces reasoning_content + no tool_choice", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "deepseek");
		expect(descriptor).toBeDefined();
		expect(descriptor?.modelsDevKey).toBe("deepseek");
		expect(descriptor?.api).toBe("openai-completions");
		expect(descriptor?.baseUrl).toBe("https://api.deepseek.com");
		// Per-model compat: deepseek-v4 reasoning models leak chat-template tool-call markers
		// (#798) and 400 on tool_choice when xhigh effort is used (#830 thread). Reasoning content
		// must round-trip on tool calls (interleaved.field=reasoning_content from models.dev).
		const compat =
			descriptor?.api === "openai-completions" ? (descriptor.compat as OpenAICompat | undefined) : undefined;
		expect(compat?.supportsReasoningEffort).toBe(true);
		expect(compat?.supportsToolChoice).toBe(false);
		expect(compat?.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat?.reasoningContentField).toBe("reasoning_content");
		expect(compat?.reasoningEffortMap?.xhigh).toBe("max");
	});
});
