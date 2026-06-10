import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies, linkOpenAIPromotionTargets } from "../scripts/generated-policies";

function createSpec<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	priority?: number;
	applyPatchToolType?: "freeform" | "function";
	cost?: ModelSpec<TApi>["cost"];
	thinking?: ModelSpec<TApi>["thinking"];
}): ModelSpec<TApi> {
	return {
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: "https://example.com",
		reasoning: overrides.reasoning ?? true,
		thinking: overrides.thinking,
		input: ["text"],
		cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides.contextWindow ?? 200000,
		maxTokens: overrides.maxTokens ?? 32000,
		priority: overrides.priority,
		applyPatchToolType: overrides.applyPatchToolType,
	};
}

describe("generated model policies", () => {
	it("re-bakes thinking metadata and applies parsed catalog corrections", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "claude-opus-4-5",
				api: "anthropic-messages",
				provider: "anthropic",
				// Stale baked metadata must be replaced by the deriver's output.
				thinking: { mode: "budget", efforts: [Effort.High] },
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
			}),
			createSpec({
				id: "anthropic.claude-opus-4-6-v1:0",
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
			}),
			createSpec({
				id: "gpt-5.2-codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 400000,
			}),
			createSpec({
				id: "gpt-5.4-mini",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 400000,
				priority: 2,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(models[0]?.cost.cacheRead).toBe(0.5);
		expect(models[0]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low", xhigh: "max" },
		});
		expect(models[1]?.cost.cacheRead).toBe(0.5);
		expect(models[1]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.contextWindow).toBe(1000000);
		expect(models[2]?.contextWindow).toBe(272000);
		expect(models[3]?.contextWindow).toBe(272000);
		expect(models[3]?.priority).toBe(1);
	});

	it("pins Claude Mythos 5 first-party Anthropic catalog metadata", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "claude-mythos-5",
				api: "anthropic-messages",
				provider: "anthropic",
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_000_000);
		expect(models[0]?.maxTokens).toBe(128_000);
		expect(models[0]?.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		expect(models[0]?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
			supportsDisplay: true,
		});
	});

	it("normalizes Copilot generated fallback limits", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "claude-opus-4.6",
				api: "anthropic-messages",
				provider: "github-copilot",
				contextWindow: 144000,
				maxTokens: 64000,
			}),
			createSpec({
				id: "gpt-5.4-mini",
				api: "openai-responses",
				provider: "github-copilot",
				contextWindow: 400000,
				maxTokens: 128000,
			}),
			createSpec({
				id: "grok-code-fast-1",
				api: "openai-completions",
				provider: "github-copilot",
				contextWindow: 128000,
				maxTokens: 64000,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(168000);
		expect(models[0]?.maxTokens).toBe(32000);
		expect(models[1]?.contextWindow).toBe(272000);
		expect(models[1]?.maxTokens).toBe(128000);
		expect(models[2]?.contextWindow).toBe(192000);
		expect(models[2]?.maxTokens).toBe(64000);
	});

	it("links spark variants and gpt-5.5 to their context promotion targets", () => {
		const models = [
			createSpec({ id: "gpt-5.3-codex-spark", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({ id: "gpt-5.5", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({ id: "gpt-5.4", api: "openai-codex-responses", provider: "openai-codex" }),
		];

		linkOpenAIPromotionTargets(models);

		expect(models[0]?.contextPromotionTarget).toBe("openai-codex/gpt-5.5");
		expect(models[1]?.contextPromotionTarget).toBe("openai-codex/gpt-5.4");
	});

	it("sets freeform apply_patch metadata for first-party GPT-5 Responses models", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({ id: "gpt-5.4", api: "openai-responses", provider: "openai" }),
			createSpec({ id: "gpt-5.3-codex-spark", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({
				id: "gpt-5.3-codex-spark",
				api: "openai-responses",
				provider: "opencode",
				applyPatchToolType: "freeform",
			}),
			createSpec({
				id: "gpt-5.4",
				api: "openai-completions",
				provider: "litellm",
				applyPatchToolType: "freeform",
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.applyPatchToolType).toBe("freeform");
		expect(models[1]?.applyPatchToolType).toBe("freeform");
		expect(models[2]?.applyPatchToolType).toBeUndefined();
		expect(models[3]?.applyPatchToolType).toBeUndefined();
	});
});
