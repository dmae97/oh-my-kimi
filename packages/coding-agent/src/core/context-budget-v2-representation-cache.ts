import type { ContextRepresentationCandidateV2 } from "./context-budget-headroom.ts";
import {
	buildContextBudgetMaterializedRepresentationCandidateKeyV2,
	buildContextBudgetRepresentationCandidateKeyV2,
	type ContextBudgetCacheKeyBaseV2,
	computeContextBudgetOutputTextHashV2,
	computeContextBudgetRepresentationFingerprintV2,
	computeContextBudgetTargetTokenBucketV2,
} from "./context-budget-v2-cache-keys.ts";
import type { MutableTokenCacheTelemetryV2 } from "./context-budget-v2-cache-telemetry.ts";
import {
	validateContextBudgetMaterializedRepresentationCacheEntryV2,
	validateContextBudgetRepresentationCacheEntryV2,
} from "./context-budget-v2-cache-validation.ts";
import type { PlannedItemV2 } from "./context-budget-v2-scoring.ts";
import type { ContextBudgetCacheProviderV2 } from "./context-budget-v2-types.ts";

interface ContextBudgetRepresentationCacheRuntimeV2 {
	readonly provider?: ContextBudgetCacheProviderV2;
	readonly keyBase: ContextBudgetCacheKeyBaseV2;
	readonly nowEpochMs: number;
	readonly ttlMs: number;
	readonly telemetry: MutableTokenCacheTelemetryV2;
}

export function applyRepresentationCacheV2(input: {
	readonly planned: PlannedItemV2;
	readonly candidates: readonly ContextRepresentationCandidateV2[];
	readonly cache: ContextBudgetRepresentationCacheRuntimeV2;
	readonly materializedEnabled?: boolean;
}): readonly ContextRepresentationCandidateV2[] {
	const provider = input.cache.provider;
	if (!provider) return input.candidates;
	const sourceHash = input.planned.contentHash;
	const resolved: ContextRepresentationCandidateV2[] = [];
	for (const candidate of input.candidates) {
		if (candidate.kind === "omit") {
			resolved.push(candidate);
			continue;
		}
		const exactKey = buildContextBudgetRepresentationCandidateKeyV2(input.cache.keyBase, candidate, sourceHash);
		const negative = provider.readNegativeRepresentation(exactKey);
		if (negative) {
			input.cache.telemetry.representationCache.negativeHits += 1;
			continue;
		}
		const cached = provider.readRepresentation(exactKey);
		if (!cached) {
			const materialized = readMaterializedRepresentationCacheV2({
				cache: input.cache,
				candidate,
				materializedEnabled: input.materializedEnabled === true,
				provider,
				sourceHash,
			});
			if (materialized) {
				resolved.push(materialized);
				continue;
			}
			input.cache.telemetry.representationCache.misses += 1;
			resolved.push({ ...candidate, cache: { hit: false, key: exactKey, keyKind: "exact" } });
			continue;
		}
		const rejection = validateContextBudgetRepresentationCacheEntryV2({
			cache: input.cache,
			cached,
			candidate,
			sourceHash,
		});
		if (rejection) {
			recordRepresentationReject(input.cache.telemetry, rejection);
			if (rejection === "stale") provider.deleteRepresentation?.(exactKey);
			resolved.push({
				...candidate,
				cache: { hit: false, key: exactKey, keyKind: "exact", rejectedReason: rejection },
			});
			continue;
		}
		resolved.push({
			...candidate,
			cache: { hit: true, key: exactKey, keyKind: cached.entry.keyKind ?? "exact", layer: cached.layer },
			compressorId: cached.entry.compressorId,
			estimatedTokens: cached.entry.estimatedTokens,
			fidelity: cached.entry.fidelity,
			sourceRef: cached.entry.sourceRef ?? candidate.sourceRef,
			summaryHash: cached.entry.summaryHash,
			text: cached.entry.text,
		});
	}
	return resolved;
}

function readMaterializedRepresentationCacheV2(input: {
	readonly cache: ContextBudgetRepresentationCacheRuntimeV2;
	readonly candidate: ContextRepresentationCandidateV2;
	readonly materializedEnabled: boolean;
	readonly provider: ContextBudgetCacheProviderV2;
	readonly sourceHash: string;
}): ContextRepresentationCandidateV2 | undefined {
	if (!input.materializedEnabled || !isMaterializableRepresentationV2(input.candidate)) return undefined;
	const key = buildContextBudgetMaterializedRepresentationCandidateKeyV2(
		input.cache.keyBase,
		input.candidate,
		input.sourceHash,
	);
	const negative = input.provider.readNegativeRepresentation(key);
	if (negative) {
		input.cache.telemetry.representationCache.negativeHits += 1;
		return undefined;
	}
	const cached = input.provider.readRepresentation(key);
	if (!cached) return undefined;
	const rejection = validateContextBudgetMaterializedRepresentationCacheEntryV2({
		cache: input.cache,
		cached,
		candidate: input.candidate,
		sourceHash: input.sourceHash,
	});
	if (rejection) {
		recordRepresentationReject(input.cache.telemetry, rejection);
		if (rejection === "stale") input.provider.deleteRepresentation?.(key);
		return { ...input.candidate, cache: { hit: false, key, keyKind: "materialized", rejectedReason: rejection } };
	}
	return {
		...input.candidate,
		cache: { hit: true, key, keyKind: "materialized", layer: cached.layer },
		compressorId: cached.entry.compressorId,
		estimatedTokens: cached.entry.estimatedTokens,
		fidelity: cached.entry.fidelity,
		sourceRef: cached.entry.sourceRef ?? input.candidate.sourceRef,
		summaryHash: cached.entry.summaryHash,
		text: cached.entry.text,
	};
}

export function writeRepresentationCacheV2(input: {
	readonly planned: PlannedItemV2;
	readonly selected: ContextRepresentationCandidateV2;
	readonly cache: ContextBudgetRepresentationCacheRuntimeV2;
	readonly materializedEnabled?: boolean;
}): void {
	if (!input.cache.provider || input.selected.kind === "omit" || input.selected.cache?.hit === true) return;
	const sourceHash = input.planned.contentHash;
	const exactKey =
		input.selected.cache?.keyKind === "exact" && input.selected.cache.key !== undefined
			? input.selected.cache.key
			: buildContextBudgetRepresentationCandidateKeyV2(input.cache.keyBase, input.selected, sourceHash);
	input.cache.provider.writeRepresentation({
		key: exactKey,
		entry: {
			compressorId: input.selected.compressorId,
			createdAtEpochMs: input.cache.nowEpochMs,
			estimatedTokens: input.selected.estimatedTokens,
			fidelity: input.selected.fidelity,
			keyKind: "exact",
			kind: input.selected.kind,
			modelId: input.cache.keyBase.modelId,
			policyVersion: input.cache.keyBase.policyVersion,
			representationFingerprint: computeContextBudgetRepresentationFingerprintV2(input.selected),
			sourceHash,
			sourceRef: input.selected.sourceRef,
			summaryHash: input.selected.summaryHash,
			text: input.selected.text,
			tokenizerId: input.cache.keyBase.tokenizerId,
		},
	});
	input.cache.telemetry.representationCache.writes += 1;
	if (input.materializedEnabled === true && isMaterializableRepresentationV2(input.selected)) {
		input.cache.provider.writeRepresentation({
			key: buildContextBudgetMaterializedRepresentationCandidateKeyV2(
				input.cache.keyBase,
				input.selected,
				sourceHash,
			),
			entry: {
				compressorId: input.selected.compressorId,
				compressorPolicyHash: input.cache.keyBase.compressorPolicyHash,
				createdAtEpochMs: input.cache.nowEpochMs,
				estimatedTokens: input.selected.estimatedTokens,
				fidelity: input.selected.fidelity,
				keyKind: "materialized",
				kind: input.selected.kind,
				modelId: input.cache.keyBase.modelId,
				outputTextHash: computeContextBudgetOutputTextHashV2(input.selected.text),
				policyVersion: input.cache.keyBase.policyVersion,
				qualityPolicyHash: input.cache.keyBase.qualityPolicyHash,
				queryIntentCluster: input.cache.keyBase.queryIntentCluster,
				representationFingerprint: computeContextBudgetRepresentationFingerprintV2(input.selected),
				sourceHash,
				sourceRef: input.selected.sourceRef,
				summaryHash: input.selected.summaryHash,
				targetTokenBucket: computeContextBudgetTargetTokenBucketV2(input.selected.estimatedTokens),
				text: input.selected.text,
				tokenizerId: input.cache.keyBase.tokenizerId,
				verification: {
					poisonScore: 0,
					queryCoverage: 1,
					secretLeakScore: 0,
					sourceCoverage: 1,
					validatorVersion: "context-budget-v2-heuristic",
				},
			},
		});
		input.cache.telemetry.representationCache.writes += 1;
	}
}

export function isMaterializableRepresentationV2(candidate: ContextRepresentationCandidateV2): boolean {
	return candidate.kind === "summary" || candidate.kind === "headroom-compressed";
}

function recordRepresentationReject(telemetry: MutableTokenCacheTelemetryV2, rejection: string): void {
	if (rejection === "stale") {
		telemetry.representationCache.staleRejects += 1;
	} else {
		telemetry.representationCache.poisonRejects += 1;
	}
}
