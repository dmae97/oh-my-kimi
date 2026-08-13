import type { ContextBudgetCacheKeyBaseV2 } from "./context-budget-v2-cache-keys.ts";
import {
	createMutableContextBudgetCacheTelemetryV2,
	type MutableTokenCacheTelemetryV2,
	withCacheTelemetry,
} from "./context-budget-v2-cache-telemetry.ts";
import {
	sourceHashesByContextBudgetItemIdV2,
	validateContextBudgetPlanCacheEntryV2,
} from "./context-budget-v2-cache-validation.ts";
import type { PlannedItemV2 } from "./context-budget-v2-scoring.ts";
import type { ContextBudgetCacheProviderV2, PromptContextBudgetPlanV2 } from "./context-budget-v2-types.ts";

export {
	CONTEXT_BUDGET_DISK_CACHE_SCHEMA_VERSION,
	createDiskContextBudgetCacheProviderV2,
	DEFAULT_DISK_CACHE_FLUSH_DEBOUNCE_MS,
	DEFAULT_DISK_CACHE_MAX_BYTES,
	DEFAULT_DISK_CACHE_MAX_ENTRIES,
	type DiskContextBudgetCacheOptionsV2,
	DiskContextBudgetCacheProviderV2,
} from "./context-budget-v2-cache-disk.ts";
export {
	buildContextBudgetExactRepresentationCacheKeyV2,
	buildContextBudgetMaterializedRepresentationCacheKeyV2,
	buildContextBudgetMaterializedRepresentationCandidateKeyV2,
	buildContextBudgetRepresentationCacheKeyV2,
	type ContextBudgetCacheKeyBaseV2,
	computeContextBudgetOutputTextHashV2,
	computeContextBudgetQueryIntentHashV2,
	computeContextBudgetRepresentationFingerprintV2,
	computeContextBudgetTargetTokenBucketV2,
	createContextBudgetCacheKeyBaseV2,
	DEFAULT_MATERIALIZED_COMPRESSOR_POLICY_HASH_V2,
	DEFAULT_MATERIALIZED_QUALITY_POLICY_HASH_V2,
} from "./context-budget-v2-cache-keys.ts";
export { createMemoryContextBudgetCacheProviderV2 } from "./context-budget-v2-cache-provider.ts";
export {
	finalizeContextBudgetCacheTelemetryV2,
	type MutableTokenCacheTelemetryV2,
	withCacheTelemetry,
} from "./context-budget-v2-cache-telemetry.ts";
export { buildContextBudgetPlanCacheKeyV2 } from "./context-budget-v2-plan-cache-keys.ts";
export {
	applyRepresentationCacheV2,
	isMaterializableRepresentationV2,
	writeRepresentationCacheV2,
} from "./context-budget-v2-representation-cache.ts";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ContextBudgetSelectionCacheV2 {
	readonly provider?: ContextBudgetCacheProviderV2;
	readonly keyBase: ContextBudgetCacheKeyBaseV2;
	readonly nowEpochMs: number;
	readonly ttlMs: number;
	readonly telemetry: MutableTokenCacheTelemetryV2;
}

export function createContextBudgetSelectionCacheV2(input: {
	readonly provider?: ContextBudgetCacheProviderV2;
	readonly keyBase: ContextBudgetCacheKeyBaseV2;
	readonly planCacheKey: string;
	readonly nowEpochMs?: number;
	readonly ttlMs?: number;
}): ContextBudgetSelectionCacheV2 {
	return {
		provider: input.provider,
		keyBase: input.keyBase,
		nowEpochMs: input.nowEpochMs ?? Date.now(),
		ttlMs: input.ttlMs ?? DEFAULT_CACHE_TTL_MS,
		telemetry: createMutableContextBudgetCacheTelemetryV2(input.planCacheKey),
	};
}

export function readValidPlanCacheV2(input: {
	readonly cache: ContextBudgetSelectionCacheV2;
	readonly key: string;
	readonly planned: readonly PlannedItemV2[];
	readonly availableTokens: number;
}): PromptContextBudgetPlanV2 | undefined {
	const read = input.cache.provider?.readPlan(input.key);
	if (!read) return undefined;
	const rejection = validateContextBudgetPlanCacheEntryV2({
		availableTokens: input.availableTokens,
		cache: input.cache,
		entry: read.entry,
		planned: input.planned,
	});
	if (rejection) {
		input.cache.telemetry.planCache.rejectedReason = rejection;
		if (rejection === "stale") input.cache.provider?.deletePlan?.(input.key);
		return undefined;
	}
	input.cache.telemetry.planCache.hit = true;
	input.cache.telemetry.planCache.layer = read.layer;
	input.cache.telemetry.tokens.savedByCache = read.entry.plan.rawTokens;
	return withCacheTelemetry(read.entry.plan, input.cache.telemetry);
}

export function writePlanCacheV2(input: {
	readonly cache: ContextBudgetSelectionCacheV2;
	readonly key: string;
	readonly plan: PromptContextBudgetPlanV2;
	readonly planned: readonly PlannedItemV2[];
}): void {
	if (!input.cache.provider || input.plan.emergency) return;
	if (input.plan.selectedRepresentations.some((representation) => representation.cache?.hit === true)) return;
	input.cache.provider.writePlan({
		key: input.key,
		entry: {
			createdAtEpochMs: input.cache.nowEpochMs,
			plan: input.plan,
			sourceHashes: sourceHashesByContextBudgetItemIdV2(input.planned),
		},
	});
}
