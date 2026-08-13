import { describe, expect, it } from "vitest";
import {
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	type ContextBudgetItemV2,
	DEFAULT_TIER_POLICY_V2,
	type PromptContextBudgetInputV2,
	planPromptContextBudgetV2,
	scoreContextBudgetItemV2,
} from "../src/core/context-budget-governor-v2.ts";
import type { ContextSourceRefV2 } from "../src/core/context-budget-headroom.ts";

function sourceRef(uri: string, retrievable = true): ContextSourceRefV2 {
	return { uri, contentHash: `hash-${uri}`, retrievable };
}

function makeItem(
	over: Partial<ContextBudgetItemV2> & Pick<ContextBudgetItemV2, "id" | "tier" | "text">,
): ContextBudgetItemV2 {
	const { id, tier, text, ...rest } = over;
	return {
		priority: "medium",
		...rest,
		id,
		tier,
		text,
	};
}

function planWith(
	items: readonly ContextBudgetItemV2[],
	over: Partial<PromptContextBudgetInputV2> = {},
): ReturnType<typeof planPromptContextBudgetV2> {
	return planPromptContextBudgetV2({
		maxTokens: 4000,
		responseReserveTokens: 0,
		safetyMarginTokens: 0,
		items,
		...over,
	});
}

describe("context budget governor v2", () => {
	it("downgrades high-priority retrievable evidence to a pointer under tight budget", () => {
		const tight = planWith(
			[
				makeItem({ id: "sys", tier: "system", priority: "hard", text: "s", tokenEstimate: 950 }),
				makeItem({
					id: "ev",
					tier: "evidence",
					priority: "high",
					text: "evidence body",
					tokenEstimate: 800,
					sourceRef: sourceRef("file:///evidence.md"),
				}),
			],
			{ maxTokens: 1000 },
		);

		const rep = tight.selectedRepresentations.find((r) => r.itemId === "ev");
		expect(rep?.kind).toBe("pointer");
		expect(tight.usedTokens).toBeLessThanOrEqual(tight.availableTokens);
	});

	it("keeps high-priority retrievable evidence ahead of low-priority tiny evidence", () => {
		const plan = planWith(
			[
				makeItem({
					id: "low-small",
					tier: "evidence",
					priority: "low",
					text: "small low priority evidence",
					tokenEstimate: 14,
				}),
				makeItem({
					id: "high-large",
					tier: "evidence",
					priority: "high",
					text: "important evidence ".repeat(200),
					tokenEstimate: 500,
					sourceRef: sourceRef("file:///h.md"),
				}),
			],
			{
				maxTokens: 100,
				safetyMarginTokens: 0,
				tierPolicy: { evidence: { floorPct: 0, ceilingPct: 0.2 } },
			},
		);

		expect(plan.includedItemIds).toContain("high-large");
		expect(plan.selectedRepresentations.find((representation) => representation.itemId === "high-large")?.kind).toBe(
			"pointer",
		);
		expect(plan.includedItemIds).not.toContain("low-small");
	});

	it("does not admit optional representations past the tier ceiling", () => {
		const plan = planWith(
			[
				makeItem({
					id: "ev-over-tier",
					tier: "evidence",
					priority: "high",
					text: "evidence that is too large for the evidence tier",
					tokenEstimate: 20,
					representations: [
						{
							kind: "summary",
							text: "still too large",
							estimatedTokens: 12,
							fidelity: "lossy",
						},
					],
				}),
			],
			{
				maxTokens: 100,
				safetyMarginTokens: 0,
				tierPolicy: { evidence: { floorPct: 0, ceilingPct: 0.1 } },
			},
		);

		const evidence = plan.tierAllocations.find((allocation) => allocation.tier === "evidence");
		expect(evidence?.usedTokens).toBeLessThanOrEqual(evidence?.ceilingTokens ?? 0);
		expect(plan.includedItemIds).not.toContain("ev-over-tier");
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				itemId: "ev-over-tier",
				reason: "tier_ceiling_exceeded",
			}),
		);
	});

	it("falls back to a smaller representation instead of omitting at the tier ceiling", () => {
		const plan = planWith(
			[
				makeItem({
					id: "ev-tier-fallback",
					tier: "evidence",
					priority: "high",
					text: "evidence too large in full form for the evidence tier",
					tokenEstimate: 20,
					representations: [
						{
							kind: "full",
							text: "evidence too large in full form for the evidence tier",
							estimatedTokens: 20,
							fidelity: "exact",
						},
						{
							kind: "summary",
							text: "small summary",
							estimatedTokens: 6,
							fidelity: "lossy",
						},
					],
				}),
			],
			{
				maxTokens: 100,
				safetyMarginTokens: 0,
				tierPolicy: { evidence: { floorPct: 0, ceilingPct: 0.1 } },
			},
		);

		// ceiling = 10 tokens: full (20) cannot fit, summary (6) can.
		expect(plan.includedItemIds).toContain("ev-tier-fallback");
		expect(
			plan.selectedRepresentations.find((representation) => representation.itemId === "ev-tier-fallback")?.kind,
		).toBe("summary");
		expect(plan.diagnostics).not.toContainEqual(
			expect.objectContaining({ itemId: "ev-tier-fallback", reason: "tier_ceiling_exceeded" }),
		);
	});

	it("checks coverage against selected representation text, not omitted raw text", () => {
		const plan = planWith(
			[
				makeItem({
					id: "korean-evidence",
					tier: "evidence",
					priority: "high",
					text: `보안 감사 증거 ${"large body ".repeat(200)}`,
					tokenEstimate: 800,
					sourceRef: sourceRef("file:///tmp/evidence.md"),
				}),
			],
			{ query: "보안 감사 증거", maxTokens: 120, safetyMarginTokens: 0 },
		);

		expect(
			plan.selectedRepresentations.find((representation) => representation.itemId === "korean-evidence")?.kind,
		).toBe("pointer");
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				reason: "coverage_gap",
				detail: expect.stringContaining("보안"),
			}),
		);
	});

	it("reports partial coverage gaps when selected context misses some query terms", () => {
		const plan = planWith(
			[
				makeItem({
					id: "sys",
					tier: "system",
					priority: "hard",
					text: "보안",
					tokenEstimate: 5,
				}),
			],
			{ query: "보안 감사 증거", maxTokens: 200 },
		);

		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				reason: "coverage_gap",
				detail: expect.stringContaining("감사"),
			}),
		);
	});

	it("reports coverage gaps for Korean query terms", () => {
		const plan = planWith(
			[
				makeItem({
					id: "sys",
					tier: "system",
					priority: "hard",
					text: "English-only system prompt",
					tokenEstimate: 20,
				}),
			],
			{ query: "보안 감사 증거", maxTokens: 200 },
		);

		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				reason: "coverage_gap",
				detail: expect.stringContaining("보안"),
			}),
		);
	});

	it("produces stable sha256 planHash for identical inputs", () => {
		const items = [makeItem({ id: "sys", tier: "system", priority: "hard", text: "s", tokenEstimate: 10 })];
		const a = planWith(items, { promptHash: "p-1" });
		const b = planWith(items, { promptHash: "p-1" });

		expect(a.planHash).toMatch(/^[a-f0-9]{64}$/u);
		expect(a.planHash).toBe(b.planHash);
		expect(a.policyVersion).toBe(CONTEXT_BUDGET_POLICY_VERSION_V2);
		expect(a.tierAllocations.length).toBe(Object.keys(DEFAULT_TIER_POLICY_V2).length);
	});

	it("emits deterministic observability metadata without raw prompt item text", () => {
		const omittedFallback = sourceRef("file:///omitted.md");
		const plan = planWith(
			[
				makeItem({
					id: "sys",
					tier: "system",
					priority: "hard",
					text: "system prompt SECRET_RAW_ITEM_TEXT",
					tokenEstimate: 10,
				}),
				makeItem({
					id: "pointer",
					tier: "evidence",
					priority: "high",
					text: "pointer evidence SECRET_POINTER_TEXT",
					tokenEstimate: 200,
					sourceRef: sourceRef("file:///pointer.md"),
				}),
				makeItem({
					id: "compressed",
					tier: "current-files",
					priority: "medium",
					text: "full current file SECRET_COMPRESSED_TEXT",
					tokenEstimate: 80,
					sourceRef: sourceRef("file:///compressed.ts"),
					representations: [
						{
							kind: "headroom-compressed",
							text: "compressed digest SECRET_COMPRESSED_TEXT",
							estimatedTokens: 9,
							fidelity: "reversible",
							sourceRef: sourceRef("file:///compressed.ts"),
							compressorId: "headroom-shadow",
						},
					],
				}),
				makeItem({
					id: "omitted",
					tier: "scratch",
					priority: "low",
					text: "omitted body SECRET_OMITTED_TEXT",
					tokenEstimate: 40,
					sourceRef: omittedFallback,
					representations: [
						{
							kind: "omit",
							text: "",
							estimatedTokens: 0,
							fidelity: "lossy",
							sourceRef: omittedFallback,
						},
					],
				}),
			],
			{ maxTokens: 100, safetyMarginTokens: 0, promptHash: "prompt-hash" },
		);

		expect(plan.observability).toEqual({
			counts: {
				selected: 3,
				omitted: 1,
				pointer: 1,
				compressed: 1,
				full: 1,
				retrievalFallback: 1,
			},
			diagnosticReasons: ["restore_on_demand_hint", "retrieval_miss_risk"],
			tokens: {
				available: plan.availableTokens,
				used: plan.usedTokens,
				raw: plan.rawTokens,
				omitted: plan.omittedTokens,
				tokenSavings: plan.rawTokens - plan.usedTokens,
			},
			planHash: plan.planHash,
			tokenOptimizer: {
				optimizerId: "legacy-token-optimizer",
				status: "quarantined_compatibility",
				active: false,
				activeContextBudgetOptimizer: "context-budget-v2",
				compatibilityOnly: true,
			},
			cache: {
				planCache: {
					hit: false,
					key: expect.any(String),
				},
				representationCache: {
					exactHits: 0,
					semanticHits: 0,
					pointerHits: 0,
					misses: 0,
					staleRejects: 0,
					poisonRejects: 0,
					negativeHits: 0,
					writes: 0,
				},
				tokens: {
					raw: plan.rawTokens,
					rendered: plan.usedTokens,
					savedByCache: 0,
					savedByCompression: plan.rawTokens - plan.usedTokens - plan.omittedTokens,
					savedByOmission: plan.omittedTokens,
				},
			},
		});
		const metadata = JSON.stringify(plan.observability);
		expect(metadata).not.toContain("SECRET_RAW_ITEM_TEXT");
		expect(metadata).not.toContain("SECRET_POINTER_TEXT");
		expect(metadata).not.toContain("SECRET_COMPRESSED_TEXT");
		expect(metadata).not.toContain("SECRET_OMITTED_TEXT");
	});

	it("keeps malformed non-finite budget observability finite and diagnostic", () => {
		const plan = planWith([makeItem({ id: "sys", tier: "system", priority: "hard", text: "s", tokenEstimate: 10 })], {
			maxTokens: Number.NaN,
			responseReserveTokens: Number.POSITIVE_INFINITY,
			safetyMarginTokens: Number.NaN,
		});

		expect(plan.emergency).toBe(true);
		expect(plan.observability.diagnosticReasons).toContain("invalid_budget");
		for (const value of [
			plan.maxTokens,
			plan.responseReserveTokens,
			plan.safetyMarginTokens,
			plan.availableTokens,
			plan.usedTokens,
			plan.rawTokens,
			plan.omittedTokens,
			plan.observability.tokens.available,
			plan.observability.tokens.used,
			plan.observability.tokens.raw,
			plan.observability.tokens.omitted,
			plan.observability.tokens.tokenSavings,
		]) {
			expect(Number.isFinite(value)).toBe(true);
		}
	});

	it("rewards relevance and penalizes token cost", () => {
		const focused = scoreContextBudgetItemV2(
			makeItem({ id: "a", tier: "skills", text: "a", relevance: 1, evidenceValue: 1 }),
			10,
		);
		const noisy = scoreContextBudgetItemV2(
			makeItem({ id: "b", tier: "skills", text: "b", relevance: 0, evidenceValue: 0 }),
			1000,
		);

		expect(focused).toBeGreaterThan(noisy);
	});
});
