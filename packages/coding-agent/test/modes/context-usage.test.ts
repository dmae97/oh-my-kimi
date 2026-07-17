/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type ContextBreakdown,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
	renderContextUsage,
} from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { type } from "arktype";

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters } as never,
		]);
		const wireEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never,
		]);
		expect(arktypeEstimate).toBe(wireEstimate);
	});
});

/**
 * Contract: the /context panel surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("renderContextUsage snapcompact section", () => {
	const themeStub = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = renderContextUsage(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
			themeStub,
		);
		expect(output).toContain("Snapcompact (estimated wire savings)");
		expect(output).toContain("System prompt (all): saves ~3.2K (9.8K text → 2 frames ≈ 6.6K)");
		expect(output).toContain("Tool results: none imaged (3 in history)");
		// 27929 logical − 3168 saved ≈ 25K on the wire.
		expect(output).toContain("Next request: ~25K tokens on the wire");
	});

	it("reports text-only models as inactive", () => {
		const output = renderContextUsage(breakdownWith({ visionCapable: false, savedTokens: 0 }), themeStub);
		expect(output).toContain("Snapcompact: inactive (model has no image input)");
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		const output = renderContextUsage(breakdownWith(undefined), themeStub);
		expect(output).not.toContain("Snapcompact");
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = [], skills: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } }, skills };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never);
		const breakdown = computeNonMessageBreakdown(session as never);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never).systemPromptTokens).not.toBe(breakdown.systemPromptTokens);
	});
});
