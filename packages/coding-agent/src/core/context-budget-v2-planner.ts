import {
	type ContextBudgetItemV2,
	type ContextBudgetTierV2,
	type ContextSourceRefV2,
	DEFAULT_HEADROOM_QUALITY_POLICY,
} from "./context-budget-headroom.ts";
import { computePlanHash } from "./context-budget-v2-plan-hash.ts";
import { compareOptionalForSelection } from "./context-budget-v2-scoring.ts";
import {
	applyPlannerRedundancyPenalties,
	buildTierAllocations,
	createPlannedItems,
	createTierUsage,
	emitCoverageDiagnostics,
	emitOmissionDiagnostics,
	selectHardItem,
	selectOptionalItem,
} from "./context-budget-v2-selection.ts";
import { allocateTiers, computeTierDemand } from "./context-budget-v2-tiers.ts";
import {
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	DEFAULT_TIER_POLICY_V2,
	type PromptContextBudgetInputV2,
	type PromptContextBudgetPlanV2,
	type QualityDiagnosticV2,
	type SelectedRepresentationV2,
	type TierBudgetPolicyV2,
} from "./context-budget-v2-types.ts";

export function planPromptContextBudgetV2(input: PromptContextBudgetInputV2): PromptContextBudgetPlanV2 {
	const modelId = input.modelId ?? "unknown";
	const qualityPolicy = input.qualityPolicy ?? DEFAULT_HEADROOM_QUALITY_POLICY;
	const policyVersion = input.policyVersion ?? CONTEXT_BUDGET_POLICY_VERSION_V2;
	const diagnostics: QualityDiagnosticV2[] = [];

	const maxTokens = Math.floor(input.maxTokens);
	const responseReserve = Math.max(0, Math.floor(input.responseReserveTokens ?? 0));
	const safetyMargin = Math.max(0, Math.floor(input.safetyMarginTokens ?? Math.ceil(maxTokens * 0.05)));
	const available = Math.max(0, maxTokens - responseReserve - safetyMargin);
	if (!Number.isFinite(input.maxTokens) || input.maxTokens < 0) {
		diagnostics.push({ reason: "invalid_budget", detail: `maxTokens must be non-negative, got ${input.maxTokens}` });
	}

	const tierPolicy: Readonly<Record<ContextBudgetTierV2, TierBudgetPolicyV2>> = {
		...DEFAULT_TIER_POLICY_V2,
		...(input.tierPolicy ?? {}),
	};
	const basePlanned = createPlannedItems(input.items, input.tokenCounter, modelId);
	applyPlannerRedundancyPenalties(basePlanned);

	const demand = computeTierDemand(basePlanned);
	const allocation = allocateTiers(available, tierPolicy, demand);
	const selection = new Map<string, SelectedRepresentationV2>();
	const tierUsed = createTierUsage();
	const omitted: ContextBudgetItemV2[] = [];
	const retrievalFallbacks: ContextSourceRefV2[] = [];
	let usedTokens = 0;

	for (const planned of basePlanned) {
		if (!planned.isHard) continue;
		usedTokens += selectHardItem(planned, selection, tierUsed);
	}
	if (usedTokens > available) {
		diagnostics.push({
			reason: "hard_pin_over_capacity",
			detail: `hard-pinned context uses ${usedTokens} tokens against ${available} available tokens`,
		});
	}

	const optionalPlanned = basePlanned.filter((planned) => !planned.isHard).sort(compareOptionalForSelection);
	for (const planned of optionalPlanned) {
		usedTokens = selectOptionalItem(planned, {
			allocation,
			available,
			diagnostics,
			omitted,
			qualityPolicy,
			retrievalFallbacks,
			selection,
			tierUsed,
			usedTokens,
		});
	}

	const omittedHighPriority = omitted.some((item) => item.priority === "high" || item.required === true);
	emitOmissionDiagnostics(omitted, diagnostics, retrievalFallbacks);
	emitCoverageDiagnostics(input.query, selection, diagnostics);

	const tierAllocations = buildTierAllocations(allocation, demand, tierUsed);
	const rawTokens = basePlanned.reduce((sum, planned) => sum + planned.fullTokens, 0);
	const omittedTokens = omitted.reduce(
		(sum, item) => sum + (basePlanned.find((planned) => planned.item.id === item.id)?.fullTokens ?? 0),
		0,
	);
	const omittedItemIds = omitted.map((item) => item.id);
	const planHash = computePlanHash({
		policyVersion,
		promptHash: input.promptHash,
		planned: basePlanned,
		selection,
		allocations: tierAllocations,
		omittedItemIds,
	});

	return {
		policyVersion,
		promptHash: input.promptHash,
		planHash,
		maxTokens: Number.isFinite(input.maxTokens) ? maxTokens : 0,
		responseReserveTokens: responseReserve,
		safetyMarginTokens: safetyMargin,
		availableTokens: available,
		usedTokens,
		omittedTokens,
		rawTokens,
		tokenSavingsRatio: rawTokens > 0 ? Math.max(0, 1 - usedTokens / rawTokens) : 0,
		emergency: usedTokens > available || diagnostics.some((diagnostic) => diagnostic.reason === "invalid_budget"),
		omittedHighPriority,
		tierAllocations,
		selectedRepresentations: [...selection.values()].sort((a, b) => a.itemId.localeCompare(b.itemId)),
		includedItemIds: basePlanned
			.map((planned) => planned.item.id)
			.filter((id) => selection.has(id))
			.sort(),
		omittedItemIds,
		diagnostics,
		retrievalFallbacks,
	};
}
