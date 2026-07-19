import type {
	ContextBudgetItemV2,
	ContextBudgetTierV2,
	ContextRepresentationCacheMetadataV2,
	ContextRepresentationCandidateV2,
	ContextRepresentationKindV2,
	ContextSourceRefV2,
	HeadroomQualityPolicyV2,
} from "./context-budget-headroom.ts";
import type { TokenCounterAdapter } from "./context-budget-token-counter.ts";
import type { ContextCacheInvalidationSnapshot } from "./context-budget-v2-cache-invalidation.ts";

export const CONTEXT_BUDGET_POLICY_VERSION_V2 = "context-budget-v2";

// Inlined from the deleted token-optimizer.ts (legacy quarantine-compatibility
// status; legacy-token-optimizer itself no longer exists as a module).
export interface TokenOptimizerRuntimeStatus {
	readonly optimizerId: "legacy-token-optimizer";
	readonly status: "quarantined_compatibility";
	readonly active: false;
	readonly activeContextBudgetOptimizer: "context-budget-v2";
	readonly compatibilityOnly: true;
}

export interface TierBudgetPolicyV2 {
	readonly floorPct: number;
	readonly ceilingPct: number;
}

export const DEFAULT_TIER_POLICY_V2: Readonly<Record<ContextBudgetTierV2, TierBudgetPolicyV2>> = {
	system: { floorPct: 0.25, ceilingPct: 0.45 },
	"active-goal": { floorPct: 0.1, ceilingPct: 0.25 },
	"current-files": { floorPct: 0.08, ceilingPct: 0.2 },
	tools: { floorPct: 0.04, ceilingPct: 0.12 },
	skills: { floorPct: 0.03, ceilingPct: 0.12 },
	mcp: { floorPct: 0.02, ceilingPct: 0.08 },
	history: { floorPct: 0.1, ceilingPct: 0.3 },
	evidence: { floorPct: 0.08, ceilingPct: 0.25 },
	scratch: { floorPct: 0, ceilingPct: 0.05 },
};

export const ALL_TIERS_V2: readonly ContextBudgetTierV2[] = [
	"system",
	"active-goal",
	"current-files",
	"tools",
	"skills",
	"mcp",
	"history",
	"evidence",
	"scratch",
];

export interface PromptContextBudgetInputV2 {
	readonly maxTokens: number;
	readonly responseReserveTokens?: number;
	readonly safetyMarginTokens?: number;
	readonly modelId?: string;
	readonly tokenizerId?: string;
	readonly policyVersion?: string;
	readonly promptHash?: string;
	readonly query?: string;
	readonly items: readonly ContextBudgetItemV2[];
	readonly tokenCounter?: TokenCounterAdapter;
	readonly tierPolicy?: Partial<Record<ContextBudgetTierV2, TierBudgetPolicyV2>>;
	readonly qualityPolicy?: HeadroomQualityPolicyV2;
	readonly cacheProvider?: ContextBudgetCacheProviderV2;
	readonly cacheNamespace?: string;
	readonly queryIntentHash?: string;
	readonly cacheBudgetBucket?: string;
	readonly redactionPolicyHash?: string;
	readonly safetyProfileHash?: string;
	readonly cacheNowEpochMs?: number;
	readonly cacheTtlMs?: number;
	readonly cacheInvalidationSnapshot?: ContextCacheInvalidationSnapshot;
}

export interface SelectedRepresentationV2 {
	readonly itemId: string;
	readonly kind: ContextRepresentationKindV2;
	readonly text: string;
	readonly estimatedTokens: number;
	readonly fidelity: ContextRepresentationCandidateV2["fidelity"];
	readonly sourceRef?: ContextSourceRefV2;
	readonly summaryHash?: string;
	readonly compressorId?: string;
	readonly cache?: ContextRepresentationCacheMetadataV2;
}

export interface TierBudgetAllocationV2 {
	readonly tier: ContextBudgetTierV2;
	readonly floorTokens: number;
	readonly ceilingTokens: number;
	readonly allocatedTokens: number;
	readonly usedTokens: number;
	readonly hardTokens: number;
}

export type QualityDiagnosticReasonV2 =
	| "omitted_high_priority"
	| "retrieval_miss_risk"
	| "restore_on_demand_hint"
	| "hard_pin_over_capacity"
	| "coverage_gap"
	| "tier_ceiling_exceeded"
	| "invalid_budget";

export interface QualityDiagnosticV2 {
	readonly reason: QualityDiagnosticReasonV2;
	readonly itemId?: string;
	readonly detail: string;
}

export interface ContextBudgetObservabilityCountsV2 {
	readonly selected: number;
	readonly omitted: number;
	readonly pointer: number;
	readonly compressed: number;
	readonly full: number;
	readonly retrievalFallback: number;
}

export interface ContextBudgetObservabilityTokensV2 {
	readonly available: number;
	readonly used: number;
	readonly raw: number;
	readonly omitted: number;
	readonly tokenSavings: number;
}

export type ContextBudgetCacheLayerV2 = "turn" | "session" | "workspace" | "shared";

export type ContextBudgetRepresentationCacheRejectReasonV2 =
	| "fingerprint_mismatch"
	| "kind_mismatch"
	| "model_mismatch"
	| "negative"
	| "policy_mismatch"
	| "poisoned"
	| "source_hash_mismatch"
	| "stale"
	| "token_invalid"
	| "tokenizer_mismatch";

export type ContextBudgetRepresentationCacheKeyKindV2 = "exact" | "materialized";

export interface ContextBudgetMaterializedVerificationV2 {
	readonly queryCoverage?: number;
	readonly sourceCoverage?: number;
	readonly secretLeakScore?: number;
	readonly poisonScore?: number;
	readonly validatorVersion?: string;
}

export interface ContextBudgetRepresentationCacheEntryV2 {
	readonly kind: ContextRepresentationKindV2;
	readonly text: string;
	readonly estimatedTokens: number;
	readonly fidelity: ContextRepresentationCandidateV2["fidelity"];
	readonly sourceHash: string;
	readonly representationFingerprint: string;
	readonly keyKind?: ContextBudgetRepresentationCacheKeyKindV2;
	readonly modelId: string;
	readonly tokenizerId: string;
	readonly policyVersion: string;
	readonly sourceRef?: ContextSourceRefV2;
	readonly summaryHash?: string;
	readonly compressorId?: string;
	readonly compressorPolicyHash?: string;
	readonly qualityPolicyHash?: string;
	readonly queryIntentCluster?: string;
	readonly outputTextHash?: string;
	readonly targetTokenBucket?: number;
	readonly verification?: ContextBudgetMaterializedVerificationV2;
	readonly createdAtEpochMs?: number;
}

export interface ContextBudgetRepresentationCacheReadV2 {
	readonly entry: ContextBudgetRepresentationCacheEntryV2;
	readonly layer?: ContextBudgetCacheLayerV2;
}

export interface ContextBudgetNegativeCacheEntryV2 {
	readonly reason: string;
	readonly createdAtEpochMs?: number;
	readonly layer?: ContextBudgetCacheLayerV2;
}

export interface ContextBudgetPlanCacheEntryV2 {
	readonly plan: PromptContextBudgetPlanV2;
	readonly sourceHashes: Readonly<Record<string, string>>;
	readonly createdAtEpochMs?: number;
}

export interface ContextBudgetPlanCacheReadV2 {
	readonly entry: ContextBudgetPlanCacheEntryV2;
	readonly layer?: ContextBudgetCacheLayerV2;
}

export interface ContextBudgetCacheProviderV2 {
	getInvalidationSnapshot?(): ContextCacheInvalidationSnapshot | undefined;
	setInvalidationSnapshot?(snapshot: ContextCacheInvalidationSnapshot): void;
	readRepresentation(key: string): ContextBudgetRepresentationCacheReadV2 | undefined;
	writeRepresentation(input: { readonly key: string; readonly entry: ContextBudgetRepresentationCacheEntryV2 }): void;
	readNegativeRepresentation(key: string): ContextBudgetNegativeCacheEntryV2 | undefined;
	writeNegativeRepresentation(input: { readonly key: string; readonly reason: string }): void;
	readPlan(key: string): ContextBudgetPlanCacheReadV2 | undefined;
	writePlan(input: { readonly key: string; readonly entry: ContextBudgetPlanCacheEntryV2 }): void;
}

export interface ContextBudgetPlanCacheTelemetryV2 {
	readonly hit: boolean;
	readonly key: string;
	readonly layer?: ContextBudgetCacheLayerV2;
	readonly rejectedReason?: string;
}

export interface ContextBudgetRepresentationCacheTelemetryV2 {
	readonly exactHits: number;
	readonly semanticHits: number;
	readonly pointerHits: number;
	readonly misses: number;
	readonly staleRejects: number;
	readonly poisonRejects: number;
	readonly negativeHits: number;
	readonly writes: number;
}

export interface ContextBudgetCacheTokenTelemetryV2 {
	readonly raw: number;
	readonly rendered: number;
	readonly savedByCache: number;
	readonly savedByCompression: number;
	readonly savedByOmission: number;
}

export interface TokenCacheTelemetryV2 {
	readonly planCache: ContextBudgetPlanCacheTelemetryV2;
	readonly representationCache: ContextBudgetRepresentationCacheTelemetryV2;
	readonly tokens: ContextBudgetCacheTokenTelemetryV2;
}

export interface PromptContextBudgetObservabilityV2 {
	readonly counts: ContextBudgetObservabilityCountsV2;
	readonly diagnosticReasons: readonly QualityDiagnosticReasonV2[];
	readonly tokens: ContextBudgetObservabilityTokensV2;
	readonly planHash: string;
	readonly cache: TokenCacheTelemetryV2;
	readonly tokenOptimizer: TokenOptimizerRuntimeStatus;
}

export interface PromptContextBudgetPlanV2 {
	readonly policyVersion: string;
	readonly promptHash?: string;
	readonly planHash: string;
	readonly maxTokens: number;
	readonly responseReserveTokens: number;
	readonly safetyMarginTokens: number;
	readonly availableTokens: number;
	readonly usedTokens: number;
	readonly omittedTokens: number;
	readonly rawTokens: number;
	readonly tokenSavingsRatio: number;
	readonly emergency: boolean;
	readonly omittedHighPriority: boolean;
	readonly tierAllocations: readonly TierBudgetAllocationV2[];
	readonly selectedRepresentations: readonly SelectedRepresentationV2[];
	readonly includedItemIds: readonly string[];
	readonly omittedItemIds: readonly string[];
	readonly diagnostics: readonly QualityDiagnosticV2[];
	readonly retrievalFallbacks: readonly ContextSourceRefV2[];
	readonly observability: PromptContextBudgetObservabilityV2;
}
