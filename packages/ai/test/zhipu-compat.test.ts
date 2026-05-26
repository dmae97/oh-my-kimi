import { describe, expect, it } from "bun:test";
import { detectOpenAICompat, resolveOpenAICompat } from "@oh-my-pi/pi-ai/providers/openai-completions-compat";
import type { Model } from "@oh-my-pi/pi-ai/types";

/**
 * Resolver-branch coverage for the `isZhipu` path added by the
 * `zhipu-coding-plan` provider. Mirrors the shape of existing zai/cerebras
 * tests: assert the contract the provider relies on (zai thinking format,
 * disabled `reasoning_effort`, no `developer` role) so future refactors of
 * `detectOpenAICompat` cannot silently regress the BigModel SKU.
 */

const baseModel: Omit<Model<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "glm-4.7",
	name: "GLM-4.7",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
};

function zhipuByProvider(): Model<"openai-completions"> {
	return {
		...baseModel,
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
	};
}

function zhipuByBaseUrl(): Model<"openai-completions"> {
	return {
		...baseModel,
		// Provider intentionally not "zhipu-coding-plan" — exercises the
		// URL-based fallback branch.
		provider: "custom",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
	};
}

describe("openai-completions compat — zhipu-coding-plan branch", () => {
	it("forces zai thinking format and disables reasoning_effort / developer role", () => {
		const compat = detectOpenAICompat(zhipuByProvider());

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.reasoningContentField).toBe("reasoning_content");
		// Zhipu shares the multi-system-message tolerance of Z.AI.
		expect(compat.supportsMultipleSystemMessages).toBe(true);
		// `isZhipu` participates in the non-standard set, so `store` is off.
		expect(compat.supportsStore).toBe(false);
	});

	it("detects zhipu by baseUrl when provider id is custom", () => {
		const compat = detectOpenAICompat(zhipuByBaseUrl());

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
	});

	it("lets explicit model.compat overrides win at the resolver layer", () => {
		const model: Model<"openai-completions"> = {
			...zhipuByProvider(),
			compat: {
				supportsDeveloperRole: true,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			},
		};
		const resolved = resolveOpenAICompat(model);

		expect(resolved.supportsDeveloperRole).toBe(true);
		expect(resolved.supportsReasoningEffort).toBe(true);
		expect(resolved.thinkingFormat).toBe("openai");
		// Untouched fields still come from the zhipu branch.
		expect(resolved.reasoningContentField).toBe("reasoning_content");
	});
});
