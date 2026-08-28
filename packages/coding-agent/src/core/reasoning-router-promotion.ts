/**
 * Promotion gate for learned reasoning-router weights.
 *
 * The router already produces a feedback ledger (`router-feedback-collector.ts`)
 * and an offline calibration stack (`scripts/reasoning-router/`: calibration,
 * held-out evaluation, golden diffing, and McNemar's exact test). What was
 * missing is the decision policy that makes automatic promotion trustworthy:
 * without it the loop is open and every weight change is a judgement call.
 *
 * This module is that policy, as a pure total function. It deliberately refuses
 * to promote on anything short of unanimous evidence:
 *
 * - outcomes that survived a two-run replay, so a flipped measurement is never
 *   credited as a win (see `reasoning-router-replay-stability.ts`);
 * - a comparison against the frozen reference policy rather than an opponent
 *   the caller picked, which is what stops baseline shopping;
 * - a statistically significant win on the held-in gold set (McNemar's exact
 *   test), computed by the caller and passed in;
 * - enough discordant pairs for that test to mean anything;
 * - the candidate — not the baseline — winning those pairs;
 * - no accuracy regression on a held-out split the calibration never saw;
 * - no unreviewed behavior changes surfaced by golden diffing; and
 * - an explicit human approval.
 *
 * "The agent tried again" is not the same as "the harness improved", so a
 * candidate that merely fails to be worse is rejected, and malformed evidence
 * fails closed rather than defaulting to promotion.
 */

/** Held-in McNemar outcome. Wins are counted in discordant pairs only. */
export interface RouterHeldInEvidence {
	/** Rows the baseline classified correctly and the candidate got wrong. */
	readonly baselineWins: number;
	/** Rows the candidate classified correctly and the baseline got wrong. */
	readonly candidateWins: number;
	readonly pValue: number;
	readonly significant: boolean;
}

/** Accuracy on a split withheld from calibration. */
export interface RouterHoldoutEvidence {
	readonly baselineCorrect: number;
	readonly candidateCorrect: number;
	readonly total: number;
}

/** How much of the evidence survived repeated identical replays. */
export interface RouterStabilityEvidence {
	/** Rows replayed under both policies, whatever bucket they landed in. */
	readonly evaluated: number;
	/** Rows withheld because repeated observations disagreed. */
	readonly unstable: number;
	/** Independent observations per row behind the credited outcomes. */
	readonly replays: number;
}

/**
 * What the candidate was measured against.
 *
 * `frozen_reference` is the shipped policy that learning never updates. A
 * candidate that only beats an opponent the caller chose has demonstrated
 * nothing, so the gate refuses to reason about `ad_hoc` comparisons.
 */
export type RouterBaselineKind = "frozen_reference" | "ad_hoc";

/** Everything the gate is allowed to consider. */
export interface RouterPromotionEvidence {
	readonly heldIn: RouterHeldInEvidence;
	readonly holdout: RouterHoldoutEvidence;
	/** Replay agreement behind every credited outcome. */
	readonly stability: RouterStabilityEvidence;
	/** Which opponent produced `heldIn` and `holdout`. */
	readonly baselineKind: RouterBaselineKind;
	/** Golden-diff changes still unreviewed at decision time. */
	readonly goldenChanges: number;
	/** True only when a human explicitly approved this exact candidate. */
	readonly humanApproved: boolean;
}

/** Tunable thresholds. Loosening these can never authorize a regression. */
export interface RouterPromotionPolicy {
	/** Minimum discordant pairs before McNemar's verdict is trusted. */
	readonly minDiscordant: number;
	/** Minimum held-out rows before "no regression" is meaningful. */
	readonly minHoldout: number;
	/** Maximum unreviewed golden-diff changes tolerated. */
	readonly maxGoldenChanges: number;
	/** Independent replays required per row before any outcome carries credit. */
	readonly minReplays: number;
	/** Maximum rows allowed to disagree across replays. */
	readonly maxUnstable: number;
	/** Require the frozen reference policy as the comparison opponent. */
	readonly requireFrozenBaseline: boolean;
	readonly requireHumanApproval: boolean;
}

export type RouterPromotionBlocker =
	| "malformed_evidence"
	| "insufficient_replays"
	| "unstable_evidence"
	| "baseline_not_frozen"
	| "insufficient_discordant_pairs"
	| "mcnemar_not_significant"
	| "candidate_not_favored"
	| "holdout_regression"
	| "insufficient_holdout"
	| "unreviewed_behavior_changes"
	| "human_approval_missing";

export interface RouterPromotionVerdict {
	readonly promote: boolean;
	/** Every independent reason promotion was refused, in evaluation order. */
	readonly blockers: readonly RouterPromotionBlocker[];
}

/**
 * Conservative defaults. `minDiscordant` of 20 keeps McNemar from ruling on a
 * handful of pairs; `maxGoldenChanges` of 0 means a reviewer accepts behavior
 * changes by regenerating the golden set, never by tolerating drift.
 *
 * `minHoldout` is 40 because the router gold set freezes 42 holdout rows (6 per
 * class × 7 classes). A higher bar would be unsatisfiable rather than strict,
 * and a gate that can never pass is a gate nobody runs.
 *
 * `minReplays` of 2 is the two-run rule: one observation cannot be checked for
 * stability at all. `maxUnstable` of 0 follows from what instability means here
 * — the routing path is deterministic, so a single disagreeing row is a defect
 * in the measurement, not an acceptable error rate to average over.
 */
export const DEFAULT_ROUTER_PROMOTION_POLICY: RouterPromotionPolicy = {
	maxGoldenChanges: 0,
	maxUnstable: 0,
	minDiscordant: 20,
	minHoldout: 40,
	minReplays: 2,
	requireFrozenBaseline: true,
	requireHumanApproval: true,
};

function isCount(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function isMalformed(evidence: RouterPromotionEvidence): boolean {
	const { goldenChanges, heldIn, holdout, stability } = evidence;
	if (!isCount(heldIn.baselineWins) || !isCount(heldIn.candidateWins)) return true;
	if (!Number.isFinite(heldIn.pValue) || heldIn.pValue < 0 || heldIn.pValue > 1) return true;
	if (!isCount(holdout.baselineCorrect) || !isCount(holdout.candidateCorrect) || !isCount(holdout.total)) return true;
	if (holdout.baselineCorrect > holdout.total || holdout.candidateCorrect > holdout.total) return true;
	if (!isCount(stability.evaluated) || !isCount(stability.unstable) || !isCount(stability.replays)) return true;
	if (stability.unstable > stability.evaluated) return true;
	return !isCount(goldenChanges);
}

/**
 * Decide whether a candidate weight set may replace the active one.
 *
 * Returns every independent blocker rather than the first, so one calibration
 * run reports the full distance to promotion instead of revealing it one
 * rejection at a time. Malformed evidence short-circuits: the gate never
 * reasons about numbers it cannot trust.
 *
 * Evidence-integrity blockers are reported ahead of statistical ones. A p-value
 * computed over unstable rows or against the wrong opponent is not a weaker
 * result, it is a result about nothing, and the report should say so first.
 */
export function evaluateRouterPromotion(
	evidence: RouterPromotionEvidence,
	policy: RouterPromotionPolicy = DEFAULT_ROUTER_PROMOTION_POLICY,
): RouterPromotionVerdict {
	if (isMalformed(evidence)) {
		return { blockers: ["malformed_evidence"], promote: false };
	}

	const { baselineKind, goldenChanges, heldIn, holdout, humanApproved, stability } = evidence;
	const blockers: RouterPromotionBlocker[] = [];

	if (stability.replays < policy.minReplays) {
		blockers.push("insufficient_replays");
	}
	if (stability.unstable > policy.maxUnstable) {
		blockers.push("unstable_evidence");
	}
	if (policy.requireFrozenBaseline && baselineKind !== "frozen_reference") {
		blockers.push("baseline_not_frozen");
	}
	if (heldIn.baselineWins + heldIn.candidateWins < policy.minDiscordant) {
		blockers.push("insufficient_discordant_pairs");
	}
	if (!heldIn.significant) {
		blockers.push("mcnemar_not_significant");
	}
	if (heldIn.candidateWins <= heldIn.baselineWins) {
		blockers.push("candidate_not_favored");
	}
	if (holdout.total < policy.minHoldout) {
		blockers.push("insufficient_holdout");
	}
	if (holdout.candidateCorrect < holdout.baselineCorrect) {
		blockers.push("holdout_regression");
	}
	if (goldenChanges > policy.maxGoldenChanges) {
		blockers.push("unreviewed_behavior_changes");
	}
	if (policy.requireHumanApproval && !humanApproved) {
		blockers.push("human_approval_missing");
	}

	return { blockers, promote: blockers.length === 0 };
}
