import { describe, expect, test } from "bun:test";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Pins fix #2 of the compaction effort-override bug. Models that reason
// natively but reject the wire `reasoning.effort` param (e.g.
// `xai-oauth/grok-build`, `compat.supportsReasoningEffort: false` on
// openai-responses*) are encoded at build time as `thinking: undefined` —
// "thinks, but exposes no control surface". `resolveOpenAiReasoningEffort`
// returns undefined for them instead of tripping `requireSupportedEffort`
// (the old user-visible "Compaction failed: Thinking effort high is not
// supported by xai-oauth/grok-build. Supported efforts:" with an empty list),
// and the wire-side `omitReasoningEffort` gate (stream.ts) remains the single
// source of truth for the actual strip.
describe("effort-dial-less reasoner encoding (regression)", () => {
	test("xai-oauth/grok-build reasons but carries no thinking config", () => {
		const grokBuild = getBundledModel("xai-oauth", "grok-build");
		if (!grokBuild) throw new Error("xai-oauth/grok-build must be in bundled models.json");
		expect(grokBuild.reasoning).toBe(true);
		expect(grokBuild.thinking).toBeUndefined();
		expect(getSupportedEfforts(grokBuild)).toEqual([]);
	});

	test("xai-oauth/grok-4.3 keeps its effort dial", () => {
		const grok43 = getBundledModel("xai-oauth", "grok-4.3");
		if (!grok43) throw new Error("xai-oauth/grok-4.3 must be in bundled models.json");
		expect(grok43.thinking).toBeDefined();
		expect(getSupportedEfforts(grok43).length).toBeGreaterThan(0);
	});

	test("xai-oauth/grok-4.20-0309-reasoning reasons but carries no thinking config", () => {
		const grokR = getBundledModel("xai-oauth", "grok-4.20-0309-reasoning");
		if (!grokR) throw new Error("xai-oauth/grok-4.20-0309-reasoning must be in bundled models.json");
		expect(grokR.reasoning).toBe(true);
		expect(grokR.thinking).toBeUndefined();
	});

	test("the no-dial encoding stays scoped to openai-responses*", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!claude) throw new Error("anthropic/claude-sonnet-4-6 must be in bundled models.json");
		expect(claude.thinking).toBeDefined();
	});
});
