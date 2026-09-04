/**
 * Claim Closure Graph V1 vocabulary.
 *
 * The flat `TaskSpec.claims` model answers "did this attempt satisfy its
 * predicates?". The closure graph answers the stricter question a verified
 * verdict needs: are all required claims closed by *qualified* witnesses —
 * bound to this source root and environment, not expired, from a source the
 * claim's policy trusts, independent enough to count separately — with no
 * counterexample, no unresolved side effect, and a complete workspace scope?
 *
 * Pure vocabulary: no behaviour, no I/O, no clock. Evaluation lives in
 * `claim-closure.ts`, structure checks in `claim-graph.ts`.
 */

export const CLAIM_GRAPH_SCHEMA_VERSION = "omk.claim-graph.v1" as const;

export type ClaimNodeKind = "requirement" | "safety" | "scope" | "quality" | "performance" | "release";
export type ClaimSeverity = "required" | "advisory";
export type ClaimRule = "all" | "any";

/** Trust lattice, highest first. A claim's `trustFloor` names the weakest source that may witness it. */
export type ObservationSource =
	| "deterministic_validator"
	| "trusted_attestation"
	| "workspace_witness"
	| "effect_reconciliation"
	| "independent_review"
	| "self_review"
	| "model_narrative";

export const OBSERVATION_TRUST_RANK: Readonly<Record<ObservationSource, number>> = {
	deterministic_validator: 6,
	trusted_attestation: 5,
	workspace_witness: 4,
	effect_reconciliation: 4,
	independent_review: 3,
	self_review: 2,
	model_narrative: 1,
};

export type ObservationPolarity = "supports" | "violates";

export type ClaimVerdict =
	| "satisfied"
	| "violated"
	| "missing"
	| "stale"
	| "incomplete_scope"
	| "insufficient_trust"
	| "waived";

/** Precedence when several verdicts compete; lower index wins. */
export const CLAIM_VERDICT_PRECEDENCE: readonly ClaimVerdict[] = [
	"violated",
	"stale",
	"incomplete_scope",
	"insufficient_trust",
	"missing",
	"waived",
	"satisfied",
];

export type WorkspaceCompleteness = "complete" | "partial_excluded" | "partial_truncated" | "unknown";

export type VerificationVerdict = "verified" | "unverified" | "inconclusive" | "violated";

export interface ClaimNode {
	readonly claimId: string;
	readonly kind: ClaimNodeKind;
	readonly statement: string;
	readonly severity: ClaimSeverity;
	/** `inputs` are child claim ids. An empty list makes this a leaf witnessed by observations. */
	readonly satisfaction: { readonly rule: ClaimRule; readonly inputs: readonly string[] };
	readonly trustFloor: ObservationSource;
	/** Distinct independence groups a leaf needs among its qualified supporting witnesses. Default 1. */
	readonly requiredWitnesses?: number;
	/** Blocked with `incomplete_scope` whenever the workspace witness is not complete. */
	readonly scopeSensitive?: boolean;
	/** Keys a witness must have attested to; any missing key makes the witness stale for this claim. */
	readonly invalidationKeys: readonly string[];
}

export interface ObservationNode {
	readonly observationId: string;
	readonly claimIds: readonly string[];
	readonly polarity: ObservationPolarity;
	readonly source: ObservationSource;
	readonly receiptId?: string;
	readonly sourceRoot: string;
	readonly environmentDigest: string;
	/** ISO-8601 instant after which the observation no longer qualifies. */
	readonly validUntil?: string;
	readonly invalidationKeys?: readonly string[];
	/** Witnesses sharing a group count once; defaults to the observation id. */
	readonly independenceGroup?: string;
}

export interface WaiverNode {
	readonly waiverId: string;
	readonly claimId: string;
	readonly issuer: string;
	readonly reason: string;
	readonly sourceRoot: string;
	readonly expiresAt: string;
}

export interface ClaimGraph {
	readonly schemaVersion: typeof CLAIM_GRAPH_SCHEMA_VERSION;
	readonly claims: readonly ClaimNode[];
}

export interface ProofClosureInput {
	readonly graph: ClaimGraph;
	readonly observations: readonly ObservationNode[];
	readonly waivers: readonly WaiverNode[];
	readonly sourceRoot: string;
	readonly environmentDigest: string;
	readonly workspaceCompleteness: WorkspaceCompleteness;
	readonly unresolvedEffectIds: readonly string[];
	/** ISO-8601 evaluation instant; injected so evaluation never reads a clock. */
	readonly now: string;
}

export type ClaimReasonCode =
	| "claim.satisfied"
	| "claim.violated"
	| "claim.missing"
	| "claim.stale"
	| "claim.incomplete_scope"
	| "claim.insufficient_trust"
	| "claim.waived";

export interface ClaimClosureEvaluation {
	readonly claimId: string;
	readonly severity: ClaimSeverity;
	readonly verdict: ClaimVerdict;
	readonly reasonCode: ClaimReasonCode;
	/** Qualified observations that decided the verdict (violations, or counted witnesses). */
	readonly observationIds: readonly string[];
	readonly waiverId?: string;
}

export interface ProofClosureResult {
	readonly verdict: VerificationVerdict;
	readonly claimEvaluations: readonly ClaimClosureEvaluation[];
	/** Required claims that are not closed, in evaluation order. */
	readonly blockingClaimIds: readonly string[];
	/** Smallest leaf set whose closure would unblock every blocking root; sorted. */
	readonly minimalBlockingCut: readonly string[];
	readonly unresolvedEffectIds: readonly string[];
	readonly workspaceCompleteness: WorkspaceCompleteness;
}
