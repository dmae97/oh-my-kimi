import type { HeadroomQualityPolicyV2 } from "./context-budget-headroom.ts";
import { sha256Canonical } from "./context-budget-v2-cache-hash.ts";
import {
	type ContextBudgetCacheKeyBaseV2,
	computeContextBudgetRepresentationFingerprintV2,
	fingerprintSourceRef,
} from "./context-budget-v2-cache-keys.ts";
import type { PlannedItemV2 } from "./context-budget-v2-scoring.ts";
import type { TierBudgetPolicyV2 } from "./context-budget-v2-types.ts";

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
		items: input.planned
			.map((planned) => ({
				ageTurns: planned.item.ageTurns ?? null,
				baseScore: planned.baseScore,
				effectiveScore: planned.effectiveScore,
				evidenceKind: planned.item.evidenceKind ?? null,
				evidenceValue: planned.item.evidenceValue ?? null,
				id: planned.item.id,
				pinReason: planned.item.pinReason ?? null,
				priority: planned.item.priority,
				recency: planned.item.recency ?? null,
				redundancyKey: planned.item.redundancyKey ?? null,
				redundancyPenalty: planned.redundancyPenalty,
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
