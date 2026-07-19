import {
	type ContextBudgetItemV2,
	type ContextBudgetTierV2,
	type ContextSourceRefV2,
	DEFAULT_HEADROOM_QUALITY_POLICY,
} from "./context-budget-headroom.ts";
import {
	buildContextBudgetPlanCacheKeyV2,
	createContextBudgetCacheKeyBaseV2,
	createContextBudgetSelectionCacheV2,
	finalizeContextBudgetCacheTelemetryV2,
	readValidPlanCacheV2,
	writePlanCacheV2,
} from "./context-budget-v2-cache.ts";
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
	type PromptContextBudgetObservabilityV2,
	type PromptContextBudgetPlanV2,
	type QualityDiagnosticV2,
	type SelectedRepresentationV2,
	type TierBudgetPolicyV2,
	type TokenOptimizerRuntimeStatus,
} from "./context-budget-v2-types.ts";

// Inlined constant replacing the deleted legacy token-optimizer.ts module's
// getTokenOptimizerRuntimeStatus(): a fixed, hardcoded compatibility status.
const TOKEN_OPTIMIZER_RUNTIME_STATUS: TokenOptimizerRuntimeStatus = {
	optimizerId: "legacy-token-optimizer",
	status: "quarantined_compatibility",
	active: false,
	activeContextBudgetOptimizer: "context-budget-v2",
	compatibilityOnly: true,
};

export function planPromptContextBudgetV2(input: PromptContextBudgetInputV2): PromptContextBudgetPlanV2 {
	const modelId = input.modelId ?? "unknown";
	const qualityPolicy = input.qualityPolicy ?? DEFAULT_HEADROOM_QUALITY_POLICY;
	const policyVersion = input.policyVersion ?? CONTEXT_BUDGET_POLICY_VERSION_V2;
	const diagnostics: QualityDiagnosticV2[] = [];

	const maxTokens = normalizeBudgetTokens("maxTokens", input.maxTokens, diagnostics);
	const responseReserve = normalizeBudgetTokens(
		"responseReserveTokens",
		input.responseReserveTokens ?? 0,
		diagnostics,
	);
	const safetyMargin = normalizeBudgetTokens(
		"safetyMarginTokens",
		input.safetyMarginTokens ?? Math.ceil(maxTokens * 0.05),
		diagnostics,
	);
	const available = Math.max(0, maxTokens - responseReserve - safetyMargin);

	const tierPolicy: Readonly<Record<ContextBudgetTierV2, TierBudgetPolicyV2>> = {
		...DEFAULT_TIER_POLICY_V2,
		...(input.tierPolicy ?? {}),
	};
	const basePlanned = createPlannedItems(input.items, input.tokenCounter, modelId);
	applyPlannerRedundancyPenalties(basePlanned);
	const rawTokens = basePlanned.reduce((sum, planned) => sum + planned.fullTokens, 0);

	const demand = computeTierDemand(basePlanned);
	const allocation = allocateTiers(available, tierPolicy, demand);
	const cacheKeyBase = createContextBudgetCacheKeyBaseV2({
		budgetBucket: input.cacheBudgetBucket ?? String(available),
		cacheInvalidationSnapshot: input.cacheInvalidationSnapshot ?? input.cacheProvider?.getInvalidationSnapshot?.(),
		modelId,
		namespace: input.cacheNamespace,
		policyVersion,
		query: input.query,
		queryIntentHash: input.queryIntentHash,
		redactionPolicyHash: input.redactionPolicyHash,
		safetyProfileHash: input.safetyProfileHash,
		tokenizerId: input.tokenizerId,
	});
	const planCacheKey = buildContextBudgetPlanCacheKeyV2({
		availableTokens: available,
		keyBase: cacheKeyBase,
		maxTokens,
		planned: basePlanned,
		promptHash: input.promptHash,
		qualityPolicy,
		responseReserveTokens: responseReserve,
		safetyMarginTokens: safetyMargin,
		tierPolicy,
	});
	const cache = createContextBudgetSelectionCacheV2({
		keyBase: cacheKeyBase,
		nowEpochMs: input.cacheNowEpochMs,
		planCacheKey,
		provider: input.cacheProvider,
		ttlMs: input.cacheTtlMs,
	});
	const cachedPlan = readValidPlanCacheV2({
		availableTokens: available,
		cache,
		key: planCacheKey,
		planned: basePlanned,
	});
	if (cachedPlan) {
		return cachedPlan;
	}
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
			cache,
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
	const observability = buildObservability({
		available,
		diagnostics,
		omittedItemIds,
		omittedTokens,
		planHash,
		rawTokens,
		retrievalFallbacks,
		selection,
		usedTokens,
		cacheTelemetry: finalizeContextBudgetCacheTelemetryV2(cache.telemetry, {
			omittedTokens,
			rawTokens,
			usedTokens,
		}),
	});

	const plan: PromptContextBudgetPlanV2 = {
		policyVersion,
		promptHash: input.promptHash,
		planHash,
		maxTokens,
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
		observability,
	};
	writePlanCacheV2({
		cache,
		key: planCacheKey,
		plan,
		planned: basePlanned,
	});
	return plan;
}

function normalizeBudgetTokens(field: string, value: number, diagnostics: QualityDiagnosticV2[]): number {
	if (!Number.isFinite(value) || value < 0) {
		diagnostics.push({
			reason: "invalid_budget",
			detail: `${field} must be a non-negative finite number, got ${value}`,
		});
		return 0;
	}
	return Math.floor(value);
}

function buildObservability(input: {
	readonly available: number;
	readonly diagnostics: readonly QualityDiagnosticV2[];
	readonly omittedItemIds: readonly string[];
	readonly omittedTokens: number;
	readonly planHash: string;
	readonly rawTokens: number;
	readonly retrievalFallbacks: readonly ContextSourceRefV2[];
	readonly selection: ReadonlyMap<string, SelectedRepresentationV2>;
	readonly usedTokens: number;
	readonly cacheTelemetry: PromptContextBudgetObservabilityV2["cache"];
}): PromptContextBudgetObservabilityV2 {
	const selected = [...input.selection.values()];
	return {
		counts: {
			selected: selected.length,
			omitted: input.omittedItemIds.length,
			pointer: selected.filter((representation) => representation.kind === "pointer").length,
			compressed: selected.filter((representation) => representation.kind === "headroom-compressed").length,
			full: selected.filter((representation) => representation.kind === "full").length,
			retrievalFallback: countUniqueRetrievalFallbacks(input.retrievalFallbacks),
		},
		diagnosticReasons: [...new Set(input.diagnostics.map((diagnostic) => diagnostic.reason))].sort(),
		tokens: {
			available: input.available,
			used: input.usedTokens,
			raw: input.rawTokens,
			omitted: input.omittedTokens,
			tokenSavings: Math.max(0, input.rawTokens - input.usedTokens),
		},
		planHash: input.planHash,
		cache: input.cacheTelemetry,
		tokenOptimizer: TOKEN_OPTIMIZER_RUNTIME_STATUS,
	};
}

function countUniqueRetrievalFallbacks(retrievalFallbacks: readonly ContextSourceRefV2[]): number {
	return new Set(
		retrievalFallbacks.map((ref) =>
			[ref.uri, ref.contentHash, ref.symbol ?? "", ref.range?.startLine ?? "", ref.range?.endLine ?? ""].join("\0"),
		),
	).size;
}
