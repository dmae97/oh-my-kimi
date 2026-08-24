import type { HeadroomQualityPolicyV2 } from "./context-budget-headroom.ts";
import { sha256Canonical } from "./context-budget-v2-cache-hash.ts";
import {
	type ContextBudgetCacheKeyBaseV2,
	computeContextBudgetRepresentationFingerprintV2,
	fingerprintSourceRef,
} from "./context-budget-v2-cache-keys.ts";
import type { PlannedItemV2 } from "./context-budget-v2-scoring.ts";
import type { TierBudgetPolicyV2 } from "./context-budget-v2-types.ts";

/**
 * Cache-key-only quantization for signals that legitimately drift every turn.
 *
 * `ageTurns`, `baseScore`, `effectiveScore`, `redundancyPenalty`, and an explicit `recency`
 * override are recomputed from scratch on every planning pass (recency decays continuously via
 * `deriveRecency()`'s `exp(-ageTurns / halfLife)`), so hashing their raw values means the plan
 * cache key changes on *every single turn* even when the resulting selection would be identical
 * -- the cache can structurally never hit past the first call in a session. Bucketing/rounding
 * them here does not touch actual selection logic (compareOptionalForSelection, tier allocation,
 * etc. still read the full-precision fields off `planned` directly); it only changes what counts
 * as "the same plan" for cache-lookup purposes. `ageTurns` buckets are log2-spaced so a bucket
 * boundary corresponds to roughly one additional recency half-life having elapsed -- the point
 * at which the decayed score has plausibly moved enough to change ranking/selection -- rather
 * than an arbitrary fixed window.
 */
function bucketAgeTurnsForCacheKeyV2(ageTurns: number | null | undefined): number | null {
	if (ageTurns === null || ageTurns === undefined || !Number.isFinite(ageTurns)) return null;
	if (ageTurns <= 0) return 0;
	return Math.floor(Math.log2(ageTurns + 1));
}

function roundScoreForCacheKeyV2(score: number | null | undefined): number | null {
	if (score === null || score === undefined || Number.isNaN(score)) return null;
	if (!Number.isFinite(score)) return score; // preserve +/-Infinity (hard-pinned items)
	return Math.round(score);
}

function roundUnitIntervalForCacheKeyV2(value: number | null | undefined): number | null {
	if (value === null || value === undefined || !Number.isFinite(value)) return null;
	return Math.round(value * 10) / 10;
}

export function buildContextBudgetPlanCacheKeyV2(input: {
	readonly keyBase: ContextBudgetCacheKeyBaseV2;
	readonly promptHash?: string;
	readonly maxTokens: number;
	readonly responseReserveTokens: number;
	readonly safetyMarginTokens: number;
	readonly availableTokens: number;
	readonly planned: readonly PlannedItemV2[];
	readonly tierPolicy: Readonly<Record<string, TierBudgetPolicyV2>>;
	readonly qualityPolicy: HeadroomQualityPolicyV2;
}): string {
	return `context-plan:${sha256Canonical({
		availableTokens: input.availableTokens,
		budgetBucket: input.keyBase.budgetBucket,
		// Only the PLAN key carries this: representation entries are content-addressed
		// by source hash and kind, so a selection-order change cannot invalidate them.
		selectionPolicyVersion: input.keyBase.selectionPolicyVersion,
		items: input.planned
			.map((planned) => ({
				ageTurns: bucketAgeTurnsForCacheKeyV2(planned.item.ageTurns),
				baseScore: roundScoreForCacheKeyV2(planned.baseScore),
				effectiveScore: roundScoreForCacheKeyV2(planned.effectiveScore),
				evidenceKind: planned.item.evidenceKind ?? null,
				evidenceValue: planned.item.evidenceValue ?? null,
				id: planned.item.id,
				pinReason: planned.item.pinReason ?? null,
				priority: planned.item.priority,
				recency: roundUnitIntervalForCacheKeyV2(planned.item.recency),
				redundancyKey: planned.item.redundancyKey ?? null,
				redundancyPenalty: roundScoreForCacheKeyV2(planned.redundancyPenalty),
				relevance: planned.item.relevance ?? null,
				representations: (planned.item.representations ?? [])
					.map((candidate) => ({
						fingerprint: computeContextBudgetRepresentationFingerprintV2(candidate),
						kind: candidate.kind,
					}))
					.sort((a, b) => a.kind.localeCompare(b.kind) || a.fingerprint.localeCompare(b.fingerprint)),
				required: planned.item.required === true,
				sourceRef: fingerprintSourceRef(planned.item.sourceRef),
				sourceHash: planned.contentHash,
				tier: planned.item.tier,
				tokenEstimate: planned.item.tokenEstimate ?? null,
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		maxTokens: input.maxTokens,
		invalidationSnapshotHash: input.keyBase.invalidationSnapshotHash ?? "none",
		modelId: input.keyBase.modelId,
		namespace: input.keyBase.namespace,
		policyVersion: input.keyBase.policyVersion,
		promptHash: input.promptHash ?? null,
		queryIntentHash: input.keyBase.queryIntentHash,
		redactionPolicyHash: input.keyBase.redactionPolicyHash,
		responseReserveTokens: input.responseReserveTokens,
		safetyMarginTokens: input.safetyMarginTokens,
		safetyProfileHash: input.keyBase.safetyProfileHash,
		tierPolicy: input.tierPolicy,
		qualityPolicy: input.qualityPolicy,
		tokenizerId: input.keyBase.tokenizerId,
	})}`;
}
