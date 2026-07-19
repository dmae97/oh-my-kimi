import type { ContextRepresentationCandidateV2, ContextRepresentationKindV2 } from "./context-budget-headroom.ts";
import { sha256Canonical, sha256Hex } from "./context-budget-v2-cache-hash.ts";
import {
	type ContextCacheInvalidationSnapshot,
	serializeContextCacheSnapshot,
} from "./context-budget-v2-cache-invalidation.ts";

const DEFAULT_CACHE_NAMESPACE = "context-budget-v2";
const DEFAULT_TOKENIZER_ID = "heuristic-v1";
const DEFAULT_REDACTION_POLICY_HASH = "none";
const DEFAULT_SAFETY_PROFILE_HASH = "default";
const NO_COMPRESSOR_ID = "none";
export const DEFAULT_MATERIALIZED_COMPRESSOR_POLICY_HASH_V2 = "context-budget-v2-default-compressor";
export const DEFAULT_MATERIALIZED_QUALITY_POLICY_HASH_V2 = "context-budget-v2-default-quality";
const MATERIALIZED_TARGET_TOKEN_BUCKET_SIZE = 100;

type ContextBudgetRepresentationFingerprintInputV2 = Pick<
	ContextRepresentationCandidateV2,
	"compressorId" | "estimatedTokens" | "fidelity" | "kind" | "sourceRef" | "summaryHash" | "text"
>;

export interface ContextBudgetCacheKeyBaseV2 {
	readonly namespace: string;
	readonly modelId: string;
	readonly tokenizerId: string;
	readonly policyVersion: string;
	readonly queryIntentHash: string;
	readonly queryIntentCluster?: string;
	readonly budgetBucket: string;
	readonly redactionPolicyHash: string;
	readonly safetyProfileHash: string;
	readonly compressorPolicyHash?: string;
	readonly qualityPolicyHash?: string;
	readonly invalidationSnapshotHash?: string;
}

export function createContextBudgetCacheKeyBaseV2(input: {
	readonly namespace?: string;
	readonly modelId: string;
	readonly tokenizerId?: string;
	readonly policyVersion: string;
	readonly query?: string;
	readonly queryIntentHash?: string;
	readonly queryIntentCluster?: string;
	readonly budgetBucket?: string;
	readonly redactionPolicyHash?: string;
	readonly safetyProfileHash?: string;
	readonly compressorPolicyHash?: string;
	readonly qualityPolicyHash?: string;
	readonly cacheInvalidationSnapshot?: ContextCacheInvalidationSnapshot;
}): ContextBudgetCacheKeyBaseV2 {
	const queryIntentHash = input.queryIntentHash ?? computeContextBudgetQueryIntentHashV2(input.query);
	return {
		namespace: input.namespace ?? DEFAULT_CACHE_NAMESPACE,
		modelId: input.modelId,
		tokenizerId: input.tokenizerId ?? DEFAULT_TOKENIZER_ID,
		policyVersion: input.policyVersion,
		queryIntentHash,
		queryIntentCluster: input.queryIntentCluster ?? queryIntentHash,
		budgetBucket: input.budgetBucket ?? "unknown",
		redactionPolicyHash: input.redactionPolicyHash ?? DEFAULT_REDACTION_POLICY_HASH,
		safetyProfileHash: input.safetyProfileHash ?? DEFAULT_SAFETY_PROFILE_HASH,
		compressorPolicyHash: input.compressorPolicyHash ?? DEFAULT_MATERIALIZED_COMPRESSOR_POLICY_HASH_V2,
		qualityPolicyHash: input.qualityPolicyHash ?? DEFAULT_MATERIALIZED_QUALITY_POLICY_HASH_V2,
		invalidationSnapshotHash:
			input.cacheInvalidationSnapshot === undefined
				? "none"
				: sha256Hex(serializeContextCacheSnapshot(input.cacheInvalidationSnapshot)),
	};
}

export function computeContextBudgetQueryIntentHashV2(query: string | undefined): string {
	const normalized = (query ?? "")
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`]+/u)
		.map((term) => term.trim())
		.filter((term) => term.length > 0)
		.sort()
		.join(" ");
	return sha256Hex(normalized.length > 0 ? normalized : "none");
}

export function buildContextBudgetRepresentationCacheKeyV2(
	input: ContextBudgetCacheKeyBaseV2 & {
		readonly representationKind: ContextRepresentationKindV2;
		readonly sourceHash: string;
		readonly representationFingerprint?: string;
		readonly compressorId?: string;
	},
): string {
	return buildContextBudgetExactRepresentationCacheKeyV2(input);
}

export function buildContextBudgetExactRepresentationCacheKeyV2(
	input: ContextBudgetCacheKeyBaseV2 & {
		readonly representationKind: ContextRepresentationKindV2;
		readonly sourceHash: string;
		readonly representationFingerprint?: string;
		readonly compressorId?: string;
	},
): string {
	return `context-representation-exact:${sha256Canonical({
		budgetBucket: input.budgetBucket,
		compressorId: input.compressorId ?? NO_COMPRESSOR_ID,
		invalidationSnapshotHash: input.invalidationSnapshotHash ?? "none",
		modelId: input.modelId,
		namespace: input.namespace,
		policyVersion: input.policyVersion,
		queryIntentHash: input.queryIntentHash,
		redactionPolicyHash: input.redactionPolicyHash,
		representationFingerprint: input.representationFingerprint ?? "none",
		representationKind: input.representationKind,
		safetyProfileHash: input.safetyProfileHash,
		sourceHash: input.sourceHash,
		tokenizerId: input.tokenizerId,
	})}`;
}

export function buildContextBudgetMaterializedRepresentationCacheKeyV2(
	input: ContextBudgetCacheKeyBaseV2 & {
		readonly representationKind: ContextRepresentationKindV2;
		readonly sourceHash: string;
		readonly compressorId?: string;
		readonly targetTokenBucket: number;
	},
): string {
	return `context-representation-materialized:${sha256Canonical({
		budgetBucket: input.budgetBucket,
		compressorId: input.compressorId ?? NO_COMPRESSOR_ID,
		compressorPolicyHash: input.compressorPolicyHash ?? DEFAULT_MATERIALIZED_COMPRESSOR_POLICY_HASH_V2,
		invalidationSnapshotHash: input.invalidationSnapshotHash ?? "none",
		modelId: input.modelId,
		namespace: input.namespace,
		policyVersion: input.policyVersion,
		qualityPolicyHash: input.qualityPolicyHash ?? DEFAULT_MATERIALIZED_QUALITY_POLICY_HASH_V2,
		queryIntentCluster: input.queryIntentCluster ?? input.queryIntentHash,
		queryIntentHash: input.queryIntentHash,
		redactionPolicyHash: input.redactionPolicyHash,
		representationKind: input.representationKind,
		safetyProfileHash: input.safetyProfileHash,
		sourceHash: input.sourceHash,
		targetTokenBucket: input.targetTokenBucket,
		tokenizerId: input.tokenizerId,
	})}`;
}

export function computeContextBudgetRepresentationFingerprintV2(
	candidate: ContextBudgetRepresentationFingerprintInputV2,
): string {
	return sha256Canonical({
		compressorId: candidate.compressorId ?? NO_COMPRESSOR_ID,
		estimatedTokens: candidate.estimatedTokens,
		fidelity: candidate.fidelity,
		kind: candidate.kind,
		sourceRef: fingerprintSourceRef(candidate.sourceRef),
		summaryHash: candidate.summaryHash ?? null,
		textHash: sha256Hex(candidate.text),
	});
}

export function buildContextBudgetRepresentationCandidateKeyV2(
	keyBase: ContextBudgetCacheKeyBaseV2,
	candidate: ContextBudgetRepresentationFingerprintInputV2,
	sourceHash: string,
): string {
	return buildContextBudgetExactRepresentationCacheKeyV2({
		...keyBase,
		compressorId: candidate.compressorId ?? NO_COMPRESSOR_ID,
		representationFingerprint: computeContextBudgetRepresentationFingerprintV2(candidate),
		representationKind: candidate.kind,
		sourceHash,
	});
}

export function buildContextBudgetMaterializedRepresentationCandidateKeyV2(
	keyBase: ContextBudgetCacheKeyBaseV2,
	candidate: ContextBudgetRepresentationFingerprintInputV2,
	sourceHash: string,
): string {
	return buildContextBudgetMaterializedRepresentationCacheKeyV2({
		...keyBase,
		compressorId: candidate.compressorId ?? NO_COMPRESSOR_ID,
		representationKind: candidate.kind,
		sourceHash,
		targetTokenBucket: computeContextBudgetTargetTokenBucketV2(candidate.estimatedTokens),
	});
}

export function computeContextBudgetTargetTokenBucketV2(tokens: number): number {
	if (!Number.isFinite(tokens) || tokens <= 0) {
		return MATERIALIZED_TARGET_TOKEN_BUCKET_SIZE;
	}
	return MATERIALIZED_TARGET_TOKEN_BUCKET_SIZE * Math.ceil(tokens / MATERIALIZED_TARGET_TOKEN_BUCKET_SIZE);
}

export function computeContextBudgetOutputTextHashV2(text: string): string {
	return sha256Hex(text);
}

export function fingerprintSourceRef(sourceRef: ContextRepresentationCandidateV2["sourceRef"]): unknown {
	if (!sourceRef) return null;
	return {
		contentHash: sourceRef.contentHash,
		range: sourceRef.range
			? {
					endLine: sourceRef.range.endLine,
					startLine: sourceRef.range.startLine,
				}
			: null,
		retrievable: sourceRef.retrievable,
		symbol: sourceRef.symbol ?? null,
		uri: sourceRef.uri,
	};
}
