import { describe, expect, it } from "vitest";
import {
	DEFAULT_ROUTER_PROMOTION_POLICY,
	evaluateRouterPromotion,
	type RouterPromotionEvidence,
} from "../src/core/reasoning-router-promotion.ts";

function evidence(over: Partial<RouterPromotionEvidence> = {}): RouterPromotionEvidence {
	return {
		baselineKind: "frozen_reference",
		goldenChanges: 0,
		heldIn: { baselineWins: 4, candidateWins: 18, pValue: 0.004, significant: true },
		holdout: { baselineCorrect: 80, candidateCorrect: 84, total: 100 },
		humanApproved: true,
		stability: { evaluated: 210, replays: 2, unstable: 0 },
		...over,
	};
}

describe("evaluateRouterPromotion", () => {
	it("promotes a candidate that clears every gate", () => {
		const verdict = evaluateRouterPromotion(evidence());
		expect(verdict.blockers).toEqual([]);
		expect(verdict.promote).toBe(true);
	});

	it("refuses promotion on too few discordant pairs even when significant", () => {
		const verdict = evaluateRouterPromotion(
			evidence({ heldIn: { baselineWins: 0, candidateWins: 5, pValue: 0.03, significant: true } }),
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("insufficient_discordant_pairs");
	});

	it("refuses promotion when McNemar is not significant", () => {
		const verdict = evaluateRouterPromotion(
			evidence({ heldIn: { baselineWins: 14, candidateWins: 16, pValue: 0.86, significant: false } }),
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("mcnemar_not_significant");
	});

	it("refuses promotion when the baseline wins the discordant pairs", () => {
		const verdict = evaluateRouterPromotion(
			evidence({ heldIn: { baselineWins: 18, candidateWins: 4, pValue: 0.004, significant: true } }),
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("candidate_not_favored");
	});

	it("refuses promotion on any held-out regression", () => {
		const verdict = evaluateRouterPromotion(
			evidence({ holdout: { baselineCorrect: 84, candidateCorrect: 83, total: 100 } }),
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("holdout_regression");
	});

	it("accepts a held-out tie as no regression", () => {
		const verdict = evaluateRouterPromotion(
			evidence({ holdout: { baselineCorrect: 84, candidateCorrect: 84, total: 100 } }),
		);
		expect(verdict.promote).toBe(true);
	});

	it("refuses promotion when the held-out set is too small to detect regression", () => {
		const verdict = evaluateRouterPromotion(
			evidence({ holdout: { baselineCorrect: 8, candidateCorrect: 9, total: 10 } }),
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("insufficient_holdout");
	});

	it("refuses promotion when golden-diff surfaces unreviewed behavior changes", () => {
		const verdict = evaluateRouterPromotion(evidence({ goldenChanges: 1 }));
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("unreviewed_behavior_changes");
	});

	it("requires explicit human approval by default", () => {
		expect(DEFAULT_ROUTER_PROMOTION_POLICY.requireHumanApproval).toBe(true);
		const verdict = evaluateRouterPromotion(evidence({ humanApproved: false }));
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("human_approval_missing");
	});

	it("reports every independent blocker at once rather than the first", () => {
		const verdict = evaluateRouterPromotion(
			evidence({
				goldenChanges: 3,
				heldIn: { baselineWins: 9, candidateWins: 2, pValue: 0.9, significant: false },
				holdout: { baselineCorrect: 90, candidateCorrect: 10, total: 100 },
				humanApproved: false,
			}),
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toEqual([
			"insufficient_discordant_pairs",
			"mcnemar_not_significant",
			"candidate_not_favored",
			"holdout_regression",
			"unreviewed_behavior_changes",
			"human_approval_missing",
		]);
	});

	it("rejects non-finite or negative evidence instead of silently promoting", () => {
		for (const broken of [
			evidence({ heldIn: { baselineWins: -1, candidateWins: 18, pValue: 0.004, significant: true } }),
			evidence({ holdout: { baselineCorrect: 80, candidateCorrect: Number.NaN, total: 100 } }),
			evidence({ goldenChanges: Number.POSITIVE_INFINITY }),
		]) {
			const verdict = evaluateRouterPromotion(broken);
			expect(verdict.promote).toBe(false);
			expect(verdict.blockers).toContain("malformed_evidence");
		}
	});

	it("never promotes when the candidate cannot beat the policy, regardless of policy loosening", () => {
		// A caller may loosen thresholds, but a held-out regression is unconditional.
		const verdict = evaluateRouterPromotion(
			evidence({ holdout: { baselineCorrect: 90, candidateCorrect: 89, total: 1000 } }),
			{
				maxGoldenChanges: 1000,
				maxUnstable: 1000,
				minDiscordant: 0,
				minHoldout: 0,
				minReplays: 0,
				requireFrozenBaseline: false,
				requireHumanApproval: false,
			},
		);
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toEqual(["holdout_regression"]);
	});

	it("refuses promotion when any credited row proved unstable across replays", () => {
		// Given one row whose repeated observations disagreed
		const verdict = evaluateRouterPromotion(evidence({ stability: { evaluated: 210, replays: 2, unstable: 1 } }));

		// Then the win is treated as possible noise, not as evidence
		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("unstable_evidence");
	});

	it("refuses promotion when rows were observed fewer times than the two-run rule", () => {
		const verdict = evaluateRouterPromotion(evidence({ stability: { evaluated: 210, replays: 1, unstable: 0 } }));

		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("insufficient_replays");
	});

	it("refuses promotion when the comparison baseline was not the frozen reference", () => {
		// Given evidence produced against a caller-chosen baseline, a candidate
		// could be promoted for beating a deliberately weak opponent.
		const verdict = evaluateRouterPromotion(evidence({ baselineKind: "ad_hoc" }));

		expect(verdict.promote).toBe(false);
		expect(verdict.blockers).toContain("baseline_not_frozen");
	});

	it("rejects stability counts that contradict themselves", () => {
		for (const broken of [
			evidence({ stability: { evaluated: 10, replays: 2, unstable: 11 } }),
			evidence({ stability: { evaluated: 210, replays: Number.NaN, unstable: 0 } }),
			evidence({ stability: { evaluated: -1, replays: 2, unstable: 0 } }),
		]) {
			const verdict = evaluateRouterPromotion(broken);
			expect(verdict.promote).toBe(false);
			expect(verdict.blockers).toContain("malformed_evidence");
		}
	});

	it("reports evidence-integrity blockers ahead of statistical ones", () => {
		// Integrity first: if the numbers cannot be trusted, the statistics
		// computed from them are not the story worth reading first.
		const verdict = evaluateRouterPromotion(
			evidence({
				baselineKind: "ad_hoc",
				heldIn: { baselineWins: 9, candidateWins: 2, pValue: 0.9, significant: false },
				stability: { evaluated: 210, replays: 1, unstable: 3 },
			}),
		);

		expect(verdict.blockers.slice(0, 3)).toEqual([
			"insufficient_replays",
			"unstable_evidence",
			"baseline_not_frozen",
		]);
	});

	it("keeps the two-run rule and frozen baseline as defaults", () => {
		expect(DEFAULT_ROUTER_PROMOTION_POLICY.minReplays).toBe(2);
		expect(DEFAULT_ROUTER_PROMOTION_POLICY.maxUnstable).toBe(0);
		expect(DEFAULT_ROUTER_PROMOTION_POLICY.requireFrozenBaseline).toBe(true);
	});
});
