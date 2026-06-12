import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { zhipuCodingPlanModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Resolver-branch coverage for the `isZhipu` path added by the
 * `zhipu-coding-plan` provider. Mirrors the shape of existing zai/cerebras
 * tests: assert the contract the provider relies on (zai thinking format,
 * disabled `reasoning_effort`, no `developer` role) so future refactors of
 * `buildOpenAICompat` cannot silently regress the BigModel SKU.
 */

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "glm-4.7",
	name: "GLM-4.7",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
};

function zhipuByProvider(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
	};
}

function zhipuByBaseUrl(): ModelSpec<"openai-completions"> {
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
		const compat = buildOpenAICompat(zhipuByProvider());

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
		const compat = buildOpenAICompat(zhipuByBaseUrl());

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
	});

	it("lets explicit model.compat overrides win at the resolver layer", () => {
		const model: ModelSpec<"openai-completions"> = {
			...zhipuByProvider(),
			compat: {
				supportsDeveloperRole: true,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			},
		};
		const resolved = buildOpenAICompat(model);

		expect(resolved.supportsDeveloperRole).toBe(true);
		expect(resolved.supportsReasoningEffort).toBe(true);
		expect(resolved.thinkingFormat).toBe("openai");
		// Untouched fields still come from the zhipu branch.
		expect(resolved.reasoningContentField).toBe("reasoning_content");
	});
});

describe("zhipu-coding-plan model discovery", () => {
	it("uses the dedicated Coding Plan endpoint by default", async () => {
		let requestedUrl = "";
		const mockFetch: FetchImpl = Object.assign(
			async (input: string | Request | URL): Promise<Response> => {
				requestedUrl = input instanceof Request ? input.url : String(input);
				return new Response(JSON.stringify({ data: [{ id: "glm-5.1", name: "GLM-5.1" }] }), {
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const options = zhipuCodingPlanModelManagerOptions({ apiKey: "test-key", fetch: mockFetch });
		expect(typeof options.fetchDynamicModels).toBe("function");
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4/models");
		expect(models?.[0]?.id).toBe("glm-5.1");
		expect(models?.[0]?.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
	});
});
