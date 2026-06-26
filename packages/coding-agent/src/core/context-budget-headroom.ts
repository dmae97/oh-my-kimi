import { deriveRepresentationCandidates } from "./context-budget-headroom-candidates.ts";
import {
	type ContextBudgetItemV2,
	type ContextBudgetPriorityV2,
	type ContextRepresentationCandidateV2,
	DEFAULT_HEADROOM_QUALITY_POLICY,
	fullTextTokens,
	type HeadroomQualityPolicyV2,
	type RepresentationBudgetContext,
} from "./context-budget-headroom-types.ts";

const PRIORITY_WEIGHT: Record<ContextBudgetPriorityV2, number> = {
	hard: 1_000_000,
	high: 120,
	medium: 60,
	low: 15,
};

const FIDELITY_BONUS: Record<ContextRepresentationCandidateV2["fidelity"], number> = {
	exact: 6,
	bounded: 3,
	reversible: 4,
	lossy: 0,
};

export function chooseHeadroomRepresentation(
	item: ContextBudgetItemV2,
	budget: RepresentationBudgetContext,
	policy: HeadroomQualityPolicyV2 = DEFAULT_HEADROOM_QUALITY_POLICY,
): ContextRepresentationCandidateV2 {
	const candidates = item.representations ?? deriveRepresentationCandidates(item, policy);
	const full = fullTextTokens(item);
	const tierOver = budget.tierUsedTokens >= budget.tierCeilingTokens;
	const globalTight = budget.remainingGlobalTokens < full;
	const tight = tierOver || globalTight;

	if (item.priority === "hard" || item.required) {
		const fullCandidate = candidates.find((candidate) => candidate.kind === "full");
		if (fullCandidate) {
			return fullCandidate;
		}
	}

	let best: ContextRepresentationCandidateV2 | undefined;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		if (isMoreExpensiveThanFull(candidate, full)) {
			continue;
		}
		if (candidate.kind !== "omit" && candidate.estimatedTokens > budget.remainingGlobalTokens) {
			continue;
		}
		const score = representationPreference(candidate, item, policy, tight);
		if (
			score > bestScore ||
			(score === bestScore && best !== undefined && compareCandidatesForChoice(candidate, best) < 0)
		) {
			best = candidate;
			bestScore = score;
		}
	}
	return best ?? candidates.find((candidate) => candidate.kind === "omit") ?? omitCandidate(item);
}

function omitCandidate(item: ContextBudgetItemV2): ContextRepresentationCandidateV2 {
	return {
		kind: "omit",
		text: "",
		estimatedTokens: 0,
		fidelity: "lossy",
		sourceRef: item.sourceRef,
	};
}

function isMoreExpensiveThanFull(candidate: ContextRepresentationCandidateV2, fullTokens: number): boolean {
	return candidate.kind !== "full" && candidate.kind !== "omit" && candidate.estimatedTokens >= fullTokens;
}

function representationPreference(
	candidate: ContextRepresentationCandidateV2,
	item: ContextBudgetItemV2,
	policy: HeadroomQualityPolicyV2,
	tight: boolean,
): number {
	const priority = PRIORITY_WEIGHT[item.priority];
	const cost = candidate.estimatedTokens;
	const fidelity = FIDELITY_BONUS[candidate.fidelity];
	const retrievable = item.sourceRef?.retrievable === true;

	switch (candidate.kind) {
		case "full": {
			let score = priority + fidelity - cost * 0.05;
			if (tight) score -= 50;
			if (isHistoryLike(item) && (item.ageTurns ?? 0) >= policy.summaryMaxAgeTurns) {
				score -= 40;
			}
			return score;
		}
		case "pointer": {
			if (!policy.preferPointerForRetrievable || !retrievable) {
				return Number.NEGATIVE_INFINITY;
			}
			let score = 40 + fidelity - cost * 0.2;
			if (tight) score += 20;
			return score;
		}
		case "summary": {
			const base = isHistoryLike(item) ? 30 : 10;
			let score = base + ageBonus(item) + fidelity - cost * 0.3;
			if (tight) score += 15;
			return score;
		}
		case "headroom-compressed": {
			if (!retrievable) {
				return Number.NEGATIVE_INFINITY;
			}
			const large = fullTextTokens(item) > policy.headroomThresholdTokens ? 35 : 5;
			let score = large + 10 + fidelity - cost * 0.5;
			if (tight) score += 18;
			return score;
		}
		case "omit": {
			if (!policy.allowOmit) {
				return Number.NEGATIVE_INFINITY;
			}
			if (tight && item.priority === "low" && retrievable) {
				return 12;
			}
			return Number.NEGATIVE_INFINITY;
		}
	}
}

function ageBonus(item: ContextBudgetItemV2): number {
	return Math.min(20, (item.ageTurns ?? 0) * 3);
}

function isHistoryLike(item: ContextBudgetItemV2): boolean {
	return item.tier === "history" || item.tier === "evidence" || item.tier === "scratch";
}

function compareCandidatesForChoice(a: ContextRepresentationCandidateV2, b: ContextRepresentationCandidateV2): number {
	if (a.estimatedTokens !== b.estimatedTokens) {
		return a.estimatedTokens - b.estimatedTokens;
	}
	return a.kind.localeCompare(b.kind);
}

export { deriveRepresentationCandidates } from "./context-budget-headroom-candidates.ts";
export {
	type ContextBudgetItemV2,
	type ContextBudgetPriorityV2,
	type ContextBudgetTierV2,
	type ContextEvidenceKindV2,
	type ContextRepresentationCandidateV2,
	type ContextRepresentationFidelityV2,
	type ContextRepresentationKindV2,
	type ContextSourceRefV2,
	DEFAULT_HEADROOM_QUALITY_POLICY,
	estimatePointerTokens,
	fnv1aHex,
	fullTextTokens,
	getHeadroomRuntimeStatus,
	type HeadroomQualityPolicyV2,
	type HeadroomRuntimeStatusV2,
	heuristicTokenCount,
	type RepresentationBudgetContext,
} from "./context-budget-headroom-types.ts";
