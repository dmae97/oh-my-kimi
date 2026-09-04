/**
 * Projects an OMK proof-closure result onto the two verdict vocabularies the
 * AdaptOrch integration already speaks: the Work Packet adjudicator's
 * five-state `VerdictState` and AdaptOrch VERA's `VerificationDecision`.
 *
 * The input is structural on purpose. `omk-adaptorch-wpl` has no
 * dependencies, so it cannot import `omk-protocol`; `ProofClosureSummary`
 * names only the fields the projection reads, and `omk-protocol`'s
 * `ProofClosureResult` satisfies it by shape (pinned by a parity test in the
 * `open-multi-agent-kit` package, which depends on both).
 *
 * Mapping, worst first, in the same order `reduceVerdicts` ranks verdicts:
 *
 * | proof result                       | VerdictState     | VERA decision              | causality           |
 * | ---------------------------------- | ---------------- | -------------------------- | ------------------- |
 * | evaluation itself failed           | `VERIFIER-ERROR` | `INCONCLUSIVE_ENVIRONMENT` | `EnvironmentCaused` |
 * | `violated`                         | `CONTRADICTED`   | `REJECT`                   | `CandidateCaused`   |
 * | `inconclusive`, effects unresolved | `INDETERMINATE`  | `ESCALATE`                 | `Ambiguous`         |
 * | `inconclusive`, workspace partial  | `INDETERMINATE`  | `INCONCLUSIVE_ENVIRONMENT` | `EnvironmentCaused` |
 * | `inconclusive`, evidence missing   | `INDETERMINATE`  | `ABSTAIN`                  | `Ambiguous`         |
 * | `unverified` (no required claims)  | `INDETERMINATE`  | `ABSTAIN`                  | `NotApplicable`     |
 * | `verified`                         | `CONFIRMED`      | `SHIP`                     | `NotApplicable`     |
 *
 * An unresolved effect escalates rather than abstains because nothing short of
 * an operator or a recovery run can close it; a partial workspace is an
 * environment limit of the measurement, not a fact about the candidate.
 * `SHIP` here means the proof closed — it is not a release authorization.
 */

import type { VerdictState } from "./adjudicator-registry.ts";
import type {
	VeraEvidenceCausality,
	VeraVerificationDecision,
	VeraVerificationOutcomeKind,
} from "./vera-vocabulary.ts";

/** Structural view of `omk-protocol` `ProofClosureResult`; only what the projection reads. */
export interface ProofClosureSummary {
	readonly verdict: "verified" | "unverified" | "inconclusive" | "violated";
	readonly unresolvedEffectIds: readonly string[];
	readonly workspaceCompleteness: "complete" | "partial_excluded" | "partial_truncated" | "unknown";
	readonly blockingClaimIds: readonly string[];
}

export const PROOF_PROJECTION_REASON_CODES = [
	"proof.evaluation_error",
	"proof.violated",
	"proof.effect_frontier_open",
	"proof.workspace_incomplete",
	"proof.evidence_missing",
	"proof.no_required_claims",
	"proof.verified",
] as const;
export type ProofProjectionReasonCode = (typeof PROOF_PROJECTION_REASON_CODES)[number];

export interface ProofProjection {
	readonly verdictState: VerdictState;
	readonly decision: VeraVerificationDecision;
	readonly causality: VeraEvidenceCausality;
	readonly reasonCode: ProofProjectionReasonCode;
}

function projection(
	verdictState: VerdictState,
	decision: VeraVerificationDecision,
	causality: VeraEvidenceCausality,
	reasonCode: ProofProjectionReasonCode,
): ProofProjection {
	return Object.freeze({ verdictState, decision, causality, reasonCode });
}

/** The projection for a proof evaluation that threw instead of producing a result. */
export function projectProofEvaluationFailure(): ProofProjection {
	return projection("VERIFIER-ERROR", "INCONCLUSIVE_ENVIRONMENT", "EnvironmentCaused", "proof.evaluation_error");
}

/** Pure, total projection of a closed proof evaluation. */
export function projectProofClosure(summary: ProofClosureSummary): ProofProjection {
	switch (summary.verdict) {
		case "verified":
			return projection("CONFIRMED", "SHIP", "NotApplicable", "proof.verified");
		case "violated":
			return projection("CONTRADICTED", "REJECT", "CandidateCaused", "proof.violated");
		case "unverified":
			return projection("INDETERMINATE", "ABSTAIN", "NotApplicable", "proof.no_required_claims");
		case "inconclusive":
			if (summary.unresolvedEffectIds.length > 0) {
				return projection("INDETERMINATE", "ESCALATE", "Ambiguous", "proof.effect_frontier_open");
			}
			if (summary.workspaceCompleteness !== "complete") {
				return projection(
					"INDETERMINATE",
					"INCONCLUSIVE_ENVIRONMENT",
					"EnvironmentCaused",
					"proof.workspace_incomplete",
				);
			}
			return projection("INDETERMINATE", "ABSTAIN", "Ambiguous", "proof.evidence_missing");
		default: {
			const unknownVerdict: never = summary.verdict;
			throw new TypeError(`Unknown proof verdict ${String(unknownVerdict)}`);
		}
	}
}

/**
 * How one VERA verifier outcome enters the OMK claim graph as a witness.
 *
 * `PASS` supports. `FAIL`, `CANDIDATE_ERROR`, and `FLAKY` violate: an observed
 * assertion failure is never erased by a later pass (plan §10.9). Environment
 * outcomes are inadmissible — they neither support nor violate, so the claim
 * stays `missing` and the closure abstains or reports an environment limit
 * instead of laundering an outage into either verdict.
 */
export type VeraOutcomeAdmission =
	| {
			readonly admissible: true;
			readonly polarity: "supports" | "violates";
			readonly causality: VeraEvidenceCausality;
	  }
	| {
			readonly admissible: false;
			readonly reason: "environment" | "timeout" | "ambiguous" | "skipped";
			readonly causality: VeraEvidenceCausality;
	  };

export function admitVeraOutcome(kind: VeraVerificationOutcomeKind): VeraOutcomeAdmission {
	switch (kind) {
		case "PASS":
			return { admissible: true, polarity: "supports", causality: "NotApplicable" };
		case "FAIL":
		case "CANDIDATE_ERROR":
		case "FLAKY":
			return { admissible: true, polarity: "violates", causality: "CandidateCaused" };
		case "ENV_ERROR":
			return { admissible: false, reason: "environment", causality: "EnvironmentCaused" };
		case "TIMEOUT":
			return { admissible: false, reason: "timeout", causality: "Ambiguous" };
		case "AMBIGUOUS":
			return { admissible: false, reason: "ambiguous", causality: "Ambiguous" };
		case "SKIPPED":
			return { admissible: false, reason: "skipped", causality: "EnvironmentCaused" };
		default: {
			const unknownKind: never = kind;
			throw new TypeError(`Unknown VERA outcome kind ${String(unknownKind)}`);
		}
	}
}
