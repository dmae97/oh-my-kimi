import { describe, expect, it } from "vitest";
import {
	assertTextChatModelForCompletion,
	classifyGrokModelRoute,
	GROK_IMAGINE_MODEL_PREFIX,
	type GrokHarnessIntent,
	isGrokImagineModelId,
	recommendedSkillTierForIntent,
} from "../src/core/grok-harness.ts";
import { GROK_OAUTH_PROVIDER } from "../src/core/grok-playbook.ts";

const allowedLaneBSkills = new Set(["packages", "programming", "debugging", "adaptorch-route", "image-prompt"]);

const harnessIntents: readonly GrokHarnessIntent[] = ["code", "debug", "plan", "image", "media"];

describe("isGrokImagineModelId", () => {
	it("detects Grok Imagine ids by their exact prefix", () => {
		expect(GROK_IMAGINE_MODEL_PREFIX).toBe("grok-imagine-");
		expect(isGrokImagineModelId("grok-imagine-fast")).toBe(true);
		expect(isGrokImagineModelId("grok-imagine-image-quality")).toBe(true);
		expect(isGrokImagineModelId("grok-4.3")).toBe(false);
		expect(isGrokImagineModelId("xai/grok-imagine-fast")).toBe(false);
	});
});

describe("classifyGrokModelRoute", () => {
	it("routes Imagine models to tools and other ids to text chat", () => {
		expect(classifyGrokModelRoute("grok-imagine-fast")).toBe("imagine-tool-only");
		expect(classifyGrokModelRoute("grok-4.3")).toBe("text-chat");
	});
});

describe("assertTextChatModelForCompletion", () => {
	it("rejects Grok OAuth Imagine ids for text completions", () => {
		expect(() => assertTextChatModelForCompletion("grok-imagine-fast", GROK_OAUTH_PROVIDER)).toThrow(
			/Grok Imagine model "grok-imagine-fast" is tool-only/,
		);
	});

	it("allows text chat ids and non-Grok providers", () => {
		expect(() => assertTextChatModelForCompletion("grok-4.3", GROK_OAUTH_PROVIDER)).not.toThrow();
		expect(() => assertTextChatModelForCompletion("grok-4.5", GROK_OAUTH_PROVIDER)).not.toThrow();
		expect(() => assertTextChatModelForCompletion("grok-imagine-fast", "openrouter")).not.toThrow();
		expect(() => assertTextChatModelForCompletion("grok-imagine-fast")).not.toThrow();
	});
});

describe("recommendedSkillTierForIntent", () => {
	it("keeps each intent in the Lane B skill allowlist and under the tier cap", () => {
		for (const intent of harnessIntents) {
			const skills = recommendedSkillTierForIntent(intent);

			expect(skills.length).toBeLessThanOrEqual(3);
			expect(skills.every((skill) => allowedLaneBSkills.has(skill))).toBe(true);
		}
	});

	it("returns focused skill tiers for each Grok intent", () => {
		expect(recommendedSkillTierForIntent("code")).toEqual(["packages", "programming"]);
		expect(recommendedSkillTierForIntent("debug")).toEqual(["packages", "debugging", "programming"]);
		expect(recommendedSkillTierForIntent("plan")).toEqual(["packages", "adaptorch-route"]);
		expect(recommendedSkillTierForIntent("image")).toEqual(["image-prompt"]);
		expect(recommendedSkillTierForIntent("media")).toEqual(["image-prompt", "adaptorch-route"]);
	});
});
