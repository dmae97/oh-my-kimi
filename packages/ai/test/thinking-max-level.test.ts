import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.ts";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/models.ts";

const GLM5_EFFORT_MODEL_IDS = [
	["cloudflare-ai-gateway", "workers-ai/@cf/zai-org/glm-5.2"],
	["cloudflare-workers-ai", "@cf/zai-org/glm-5.2"],
	["fireworks", "accounts/fireworks/models/glm-5p2"],
	["fireworks", "accounts/fireworks/routers/glm-5p2-fast"],
	["huggingface", "zai-org/GLM-5.2"],
	["nvidia", "z-ai/glm-5.2"],
	["opencode", "glm-5.2"],
	["opencode-go", "glm-5.2"],
	["openrouter", "z-ai/glm-5.2"],
	["together", "zai-org/GLM-5.2"],
	["vercel-ai-gateway", "zai/glm-5.2"],
	["vercel-ai-gateway", "zai/glm-5.2-fast"],
	["zai", "glm-5.2"],
	["zai", "glm-5.2-highspeed"],
	["zai", "glm-5.3"],
	["zai-coding-cn", "glm-5.2"],
	["zai-coding-cn", "glm-5.2-highspeed"],
	["zai-coding-cn", "glm-5.3"],
	["opencode-go", "glm-5.3"],
] as const;

describe("max thinking level", () => {
	it.each(GLM5_EFFORT_MODEL_IDS)("exposes the max thinking level for GLM-5.2+ on %s (%s)", (provider, id) => {
		const model = getModels(provider).find((candidate) => candidate.id === id);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(model!.thinkingLevelMap?.max).toBe("max");
	});

	it("covers every GLM-5.2+ model in the registry with a max mapping", () => {
		const unmapped: string[] = [];
		for (const [provider, models] of Object.entries(MODELS)) {
			for (const model of Object.values(models)) {
				// Mirrors isGlm5ReasoningEffortModel() in scripts/generate-models.ts: GLM-5.2 and later.
				const glmMinorVersion = /glm-?5[.-]?p?(\d+)/i.exec(model.id);
				if (glmMinorVersion !== null && Number(glmMinorVersion[1]) >= 2) {
					if (model.thinkingLevelMap?.max !== "max") unmapped.push(`${provider}/${model.id}`);
				}
			}
		}
		expect(unmapped).toEqual([]);
	});

	it.each(["claude-opus-4-7", "claude-opus-4-8"] as const)(
		"exposes both xhigh and max for %s (opus flagship)",
		(id) => {
			const model = getModel("anthropic", id);
			expect(model).toBeDefined();
			const levels = getSupportedThinkingLevels(model!);
			expect(levels).toContain("xhigh");
			expect(levels).toContain("max");
			expect(model!.thinkingLevelMap?.xhigh).toBe("xhigh");
			expect(model!.thinkingLevelMap?.max).toBe("max");
		},
	);

	// models.dev reasoning_options: grok-4.6 exposes low/medium/high/xhigh, while grok-4.5 and
	// grok-4.3 stop at high. Top tiers are only visible when explicitly mapped, so an unmapped
	// grok-4.6 would silently clamp `/thinking xhigh` down to high.
	it.each([
		["xai", "grok-4.6"],
		["openrouter", "x-ai/grok-4.6"],
		["vercel-ai-gateway", "xai/grok-4.6"],
		["github-copilot", "grok-4.6"],
		["opencode", "grok-4.6"],
	] as const)("exposes the xhigh thinking level for grok-4.6 on %s (%s)", (provider, id) => {
		const model = getModels(provider).find((candidate) => candidate.id === id);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(model!.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(clampThinkingLevel(model!, "xhigh")).toBe("xhigh");
	});

	it.each(["grok-4.5", "grok-4.3"] as const)("keeps %s capped at high (no upstream xhigh tier)", (id) => {
		const model = getModel("xai", id);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(model!.thinkingLevelMap?.max).toBe("high");
		// xhigh is hidden; clamp walks up to the next exposed alias, which maps to high.
		expect(clampThinkingLevel(model!, "xhigh")).toBe("max");
		expect(clampThinkingLevel(model!, "max")).toBe("max");
	});

	it("keeps Opus 4.6 topping out at effort max via xhigh (no separate max level)", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
		expect(model!.thinkingLevelMap?.xhigh).toBe("max");
	});

	it("does not expose max for models without a max mapping", () => {
		const sonnet5 = getModel("anthropic", "claude-sonnet-5");
		expect(sonnet5).toBeDefined();
		expect(getSupportedThinkingLevels(sonnet5!)).not.toContain("max");

		const sonnet46 = getModel("anthropic", "claude-sonnet-4-6");
		expect(sonnet46).toBeDefined();
		expect(getSupportedThinkingLevels(sonnet46!)).not.toContain("max");
	});

	it("clamps a max request down to the highest supported level on models without max", () => {
		const sonnet5 = getModel("anthropic", "claude-sonnet-5");
		// Sonnet 5 tops out at "high"; requesting "max" should clamp down, never throw.
		expect(clampThinkingLevel(sonnet5!, "max")).toBe("high");
	});

	it("clamps an xhigh request up to max on models whose only top tier is max", () => {
		const deepseek = getModel("deepseek", "deepseek-v4-pro");
		expect(deepseek).toBeDefined();
		// DeepSeek V4 exposes off/high/xhigh (xhigh -> effort max); "max" is not a separate level.
		expect(getSupportedThinkingLevels(deepseek!)).not.toContain("max");
		expect(deepseek!.thinkingLevelMap?.xhigh).toBe("max");
	});
});
