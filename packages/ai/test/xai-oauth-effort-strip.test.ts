import { describe, expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { modelOmitsReasoningEffort } from "../src/model-thinking";

// Pins fix #2 of the compaction effort-override bug. Before this fix,
// `resolveOpenAiReasoningEffort` called `requireSupportedEffort` which threw
// for any model with `compat.supportsReasoningEffort: false` (e.g.
// `xai-oauth/grok-build`) — producing the user-visible "Compaction failed:
// Thinking effort high is not supported by xai-oauth/grok-build. Supported
// efforts:" (empty list). The fix routes through the explicit
// `modelOmitsReasoningEffort` predicate, which lets the wire-side
// `omitReasoningEffort` gate (providers/xai-responses.ts:78) remain the
// single source of truth for the actual strip.
describe("modelOmitsReasoningEffort (regression)", () => {
	test("returns true for xai-oauth/grok-build (supportsReasoningEffort: false)", () => {
		const grokBuild = getBundledModel("xai-oauth", "grok-build");
		if (!grokBuild) throw new Error("xai-oauth/grok-build must be in bundled models.json");
		expect(modelOmitsReasoningEffort(grokBuild)).toBe(true);
	});

	test("returns false for xai-oauth/grok-4.3 (effort-capable)", () => {
		const grok43 = getBundledModel("xai-oauth", "grok-4.3");
		if (!grok43) throw new Error("xai-oauth/grok-4.3 must be in bundled models.json");
		expect(modelOmitsReasoningEffort(grok43)).toBe(false);
	});

	test("returns true for xai-oauth/grok-4.20-0309-reasoning (supportsReasoningEffort: false)", () => {
		const grokR = getBundledModel("xai-oauth", "grok-4.20-0309-reasoning");
		if (!grokR) throw new Error("xai-oauth/grok-4.20-0309-reasoning must be in bundled models.json");
		expect(modelOmitsReasoningEffort(grokR)).toBe(true);
	});

	test("returns false for an Anthropic model (different api surface)", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!claude) throw new Error("anthropic/claude-sonnet-4-6 must be in bundled models.json");
		expect(modelOmitsReasoningEffort(claude)).toBe(false);
	});

	test("returns false for an openai-completions model (out of scope)", () => {
		const openai = getBundledModel("openai", "gpt-4o-mini");
		if (!openai) throw new Error("openai/gpt-4o-mini must be in bundled models.json");
		// gpt-4o-mini is openai-completions, not openai-responses* — predicate
		// must return false even if compat had supportsReasoningEffort: false.
		expect(modelOmitsReasoningEffort(openai)).toBe(false);
	});
});
