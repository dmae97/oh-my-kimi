/**
 * AdaptOrch VERA vocabulary, mirrored from the engine's exported enums.
 *
 * Source of truth: the `StrEnum` classes in `adaptorch.vera_types`
 * (`VerificationOutcomeKind`, `EvidenceCausality`, `EvidenceSeverity`,
 * `VerificationDecision`, `DriftStatus`), read at engine revision
 * `81b5fb2fe` on 2026-09-04. `test/vera-vocabulary-parity.test.ts` re-reads
 * the engine source whenever a checkout is available (`ADAPTORCH_SOURCE`,
 * default `/home/yu/projects/adaptorch`), so a value added or renamed on the
 * engine side fails here instead of drifting silently. These arrays are the
 * only place the values are written down on the OMK side; every guard and
 * projection in this package derives from them.
 *
 * What a VERA decision is not: `SHIP` is a provenance-bearing classification
 * of verifier evidence, never a release authorization or a correctness proof.
 */

/** Per-verifier outcome classification; candidate failures stay separate from environment failures. */
export const VERA_VERIFICATION_OUTCOME_KINDS = [
	"PASS",
	"FAIL",
	"ENV_ERROR",
	"CANDIDATE_ERROR",
	"TIMEOUT",
	"FLAKY",
	"AMBIGUOUS",
	"SKIPPED",
] as const;
export type VeraVerificationOutcomeKind = (typeof VERA_VERIFICATION_OUTCOME_KINDS)[number];

/** Who is responsible for a piece of evidence. */
export const VERA_EVIDENCE_CAUSALITIES = [
	"CandidateCaused",
	"EnvironmentCaused",
	"Ambiguous",
	"NotApplicable",
] as const;
export type VeraEvidenceCausality = (typeof VERA_EVIDENCE_CAUSALITIES)[number];

export const VERA_EVIDENCE_SEVERITIES = ["critical", "major", "minor", "informational"] as const;
export type VeraEvidenceSeverity = (typeof VERA_EVIDENCE_SEVERITIES)[number];

/** Final decision; `ABSTAIN` and `ESCALATE` are first-class results and never fold into `REJECT`. */
export const VERA_VERIFICATION_DECISIONS = [
	"SHIP",
	"REJECT",
	"ABSTAIN",
	"ESCALATE",
	"INCONCLUSIVE_ENVIRONMENT",
] as const;
export type VeraVerificationDecision = (typeof VERA_VERIFICATION_DECISIONS)[number];

export const VERA_DRIFT_STATUSES = ["VALID", "DEGRADED", "STALE", "INVALID"] as const;
export type VeraDriftStatus = (typeof VERA_DRIFT_STATUSES)[number];

function memberOf<const T extends readonly string[]>(values: T): (value: unknown) => value is T[number] {
	const set: ReadonlySet<string> = new Set(values);
	return (value: unknown): value is T[number] => typeof value === "string" && set.has(value);
}

export const isVeraVerificationOutcomeKind = memberOf(VERA_VERIFICATION_OUTCOME_KINDS);
export const isVeraEvidenceCausality = memberOf(VERA_EVIDENCE_CAUSALITIES);
export const isVeraEvidenceSeverity = memberOf(VERA_EVIDENCE_SEVERITIES);
export const isVeraVerificationDecision = memberOf(VERA_VERIFICATION_DECISIONS);
export const isVeraDriftStatus = memberOf(VERA_DRIFT_STATUSES);
