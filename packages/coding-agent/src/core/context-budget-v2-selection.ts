import {
	type ContextBudgetItemV2,
	type ContextBudgetTierV2,
	type ContextRepresentationCandidateV2,
	type ContextSourceRefV2,
	chooseHeadroomRepresentation,
	fullTextTokens,
} from "./context-budget-headroom.ts";
import { createFallbackTokenCounter, type TokenCounterAdapter } from "./context-budget-token-counter.ts";
import { computeCoverageGap } from "./context-budget-v2-coverage.ts";
import { contentHashOf } from "./context-budget-v2-plan-hash.ts";
import { applyRedundancyPenalties, type PlannedItemV2, scoreContextBudgetItemV2 } from "./context-budget-v2-scoring.ts";
import {
	ALL_TIERS_V2,
	type QualityDiagnosticV2,
	type SelectedRepresentationV2,
	type TierBudgetAllocationV2,
} from "./context-budget-v2-types.ts";

export interface OptionalSelectionState {
	readonly allocation: ReadonlyMap<ContextBudgetTierV2, { readonly ceiling: number }>;
	readonly available: number;
	readonly diagnostics: QualityDiagnosticV2[];
	readonly omitted: ContextBudgetItemV2[];
	readonly qualityPolicy: Parameters<typeof chooseHeadroomRepresentation>[2];
	readonly retrievalFallbacks: ContextSourceRefV2[];
	readonly selection: Map<string, SelectedRepresentationV2>;
	readonly tierUsed: Record<ContextBudgetTierV2, number>;
	readonly usedTokens: number;
}

export function createPlannedItems(
	items: readonly ContextBudgetItemV2[],
	tokenCounter: TokenCounterAdapter | undefined,
	modelId: string,
): PlannedItemV2[] {
	const counter = tokenCounter ?? createFallbackTokenCounter();
	return items.map((item) => {
		const overrideTokenEstimate = item.tokenEstimate ?? counter.countText(item.text, modelId).tokens;
		const itemWithTokens =
			item.tokenEstimate === undefined ? { ...item, tokenEstimate: overrideTokenEstimate } : item;
		const fullTokens = fullTextTokens(itemWithTokens);
		const isHard = item.priority === "hard" || item.required === true;
		const baseScore = isHard ? Number.POSITIVE_INFINITY : scoreContextBudgetItemV2(itemWithTokens, fullTokens);
		return {
			item: itemWithTokens,
			fullTokens,
			contentHash: contentHashOf(item.text),
			baseScore,
			redundancyPenalty: 0,
			effectiveScore: baseScore,
			isHard,
		};
	});
}

export function applyPlannerRedundancyPenalties(plannedItems: PlannedItemV2[]): void {
	const penalties = applyRedundancyPenalties(plannedItems.filter((planned) => !planned.isHard));
	for (const planned of plannedItems) {
		const penalty = penalties.get(planned.item.id);
		if (penalty === undefined) continue;
		planned.redundancyPenalty = penalty;
		planned.effectiveScore = planned.baseScore - penalty;
	}
}

export function selectHardItem(
	planned: PlannedItemV2,
	selection: Map<string, SelectedRepresentationV2>,
	tierUsed: Record<ContextBudgetTierV2, number>,
): number {
	const candidate: ContextRepresentationCandidateV2 = {
		kind: "full",
		text: planned.item.text,
		estimatedTokens: planned.fullTokens,
		fidelity: planned.item.tokenEstimate !== undefined ? "exact" : "bounded",
		sourceRef: planned.item.sourceRef,
	};
	selection.set(planned.item.id, toSelected(planned.item.id, candidate));
	tierUsed[planned.item.tier] += planned.fullTokens;
	return planned.fullTokens;
}

export function selectOptionalItem(planned: PlannedItemV2, state: OptionalSelectionState): number {
	if (state.usedTokens >= state.available) {
		omitItem(planned, state);
		return state.usedTokens;
	}
	const tierCeiling = state.allocation.get(planned.item.tier)?.ceiling ?? state.available;
	const remaining = Math.max(0, state.available - state.usedTokens);
	const chosen = chooseHeadroomRepresentation(
		planned.item,
		{
			tierUsedTokens: state.tierUsed[planned.item.tier],
			tierCeilingTokens: tierCeiling,
			remainingGlobalTokens: remaining,
		},
		state.qualityPolicy,
	);
	if (chosen.kind === "omit") {
		omitItem(planned, state);
		return state.usedTokens;
	}
	if (state.tierUsed[planned.item.tier] + chosen.estimatedTokens > tierCeiling) {
		state.diagnostics.push({
			reason: "tier_ceiling_exceeded",
			itemId: planned.item.id,
			detail: `${planned.item.tier} item "${planned.item.id}" needs ${chosen.estimatedTokens} tokens with ${Math.max(0, tierCeiling - state.tierUsed[planned.item.tier])} tier tokens remaining`,
		});
		omitItem(planned, state);
		return state.usedTokens;
	}
	if (state.usedTokens + chosen.estimatedTokens > state.available) {
		omitItem(planned, state);
		return state.usedTokens;
	}
	state.selection.set(planned.item.id, toSelected(planned.item.id, chosen));
	state.tierUsed[planned.item.tier] += chosen.estimatedTokens;
	return state.usedTokens + chosen.estimatedTokens;
}

export function emitOmissionDiagnostics(
	omitted: readonly ContextBudgetItemV2[],
	diagnostics: QualityDiagnosticV2[],
	retrievalFallbacks: ContextSourceRefV2[],
): void {
	for (const item of omitted) {
		if (item.priority === "high" || item.required === true) {
			diagnostics.push({
				reason: "omitted_high_priority",
				itemId: item.id,
				detail: `${item.tier} item "${item.id}" could not fit within the prompt budget`,
			});
		}
		if (item.sourceRef?.retrievable) {
			diagnostics.push({
				reason: "restore_on_demand_hint",
				itemId: item.id,
				detail: `retrievable "${item.id}" kept as fallback via ${item.sourceRef.uri}`,
			});
			retrievalFallbacks.push(item.sourceRef);
		}
	}
}

export function emitCoverageDiagnostics(
	query: string | undefined,
	selection: ReadonlyMap<string, SelectedRepresentationV2>,
	diagnostics: QualityDiagnosticV2[],
): void {
	const coverage = computeCoverageGap(
		query,
		[...selection.values()].map((representation) => representation.text),
	);
	if (!coverage.gap) return;
	diagnostics.push({
		reason: "coverage_gap",
		detail: `query terms not covered by selected context: ${coverage.missing.join(", ")}`,
	});
}

export function buildTierAllocations(
	allocation: ReadonlyMap<
		ContextBudgetTierV2,
		{ readonly floor: number; readonly ceiling: number; readonly allocated: number }
	>,
	demand: ReadonlyMap<ContextBudgetTierV2, { readonly hard: number }>,
	tierUsed: Record<ContextBudgetTierV2, number>,
): TierBudgetAllocationV2[] {
	return ALL_TIERS_V2.map((tier) => {
		const raw = allocation.get(tier) ?? { floor: 0, ceiling: 0, allocated: 0 };
		return {
			tier,
			floorTokens: raw.floor,
			ceilingTokens: raw.ceiling,
			allocatedTokens: raw.allocated,
			usedTokens: tierUsed[tier],
			hardTokens: demand.get(tier)?.hard ?? 0,
		};
	});
}

export function createTierUsage(): Record<ContextBudgetTierV2, number> {
	return {
		system: 0,
		"active-goal": 0,
		"current-files": 0,
		tools: 0,
		skills: 0,
		mcp: 0,
		history: 0,
		evidence: 0,
		scratch: 0,
	};
}

function toSelected(itemId: string, candidate: ContextRepresentationCandidateV2): SelectedRepresentationV2 {
	return {
		itemId,
		kind: candidate.kind,
		text: candidate.text,
		estimatedTokens: candidate.estimatedTokens,
		fidelity: candidate.fidelity,
		sourceRef: candidate.sourceRef,
		summaryHash: candidate.summaryHash,
		compressorId: candidate.compressorId,
	};
}

function omitItem(
	planned: PlannedItemV2,
	state: Pick<OptionalSelectionState, "diagnostics" | "omitted" | "retrievalFallbacks">,
): void {
	state.omitted.push(planned.item);
	if (planned.item.sourceRef?.retrievable) {
		state.diagnostics.push({
			reason: "retrieval_miss_risk",
			itemId: planned.item.id,
			detail: `retrievable ${planned.item.tier} item "${planned.item.id}" omitted; keep pointer for restore-on-demand`,
		});
		state.retrievalFallbacks.push(planned.item.sourceRef);
	}
}
