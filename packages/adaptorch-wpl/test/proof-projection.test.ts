import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	admitVeraOutcome,
	PROOF_PROJECTION_REASON_CODES,
	type ProofClosureSummary,
	projectProofClosure,
	projectProofEvaluationFailure,
} from "../src/proof-projection.ts";
import {
	isVeraEvidenceCausality,
	isVeraVerificationDecision,
	VERA_VERIFICATION_OUTCOME_KINDS,
} from "../src/vera-vocabulary.ts";

const VERDICT_STATES = ["CONFIRMED", "CONTRADICTED", "CORROBORATED-FAILURE", "INDETERMINATE", "VERIFIER-ERROR"];

function summary(patch: Partial<ProofClosureSummary> = {}): ProofClosureSummary {
	return {
		verdict: "verified",
		unresolvedEffectIds: [],
		workspaceCompleteness: "complete",
		blockingClaimIds: [],
		...patch,
	};
}

describe("projectProofClosure", () => {
	it("maps each closed verdict to the documented WPL and VERA pair", () => {
		expect(projectProofClosure(summary())).toEqual({
			verdictState: "CONFIRMED",
			decision: "SHIP",
			causality: "NotApplicable",
			reasonCode: "proof.verified",
		});
		expect(projectProofClosure(summary({ verdict: "violated", blockingClaimIds: ["a"] }))).toEqual({
			verdictState: "CONTRADICTED",
			decision: "REJECT",
			causality: "CandidateCaused",
			reasonCode: "proof.violated",
		});
		expect(projectProofClosure(summary({ verdict: "unverified" }))).toEqual({
			verdictState: "INDETERMINATE",
			decision: "ABSTAIN",
			causality: "NotApplicable",
			reasonCode: "proof.no_required_claims",
		});
	});

	it("ranks inconclusive causes: open effects escalate, partial workspace is environment, missing evidence abstains", () => {
		expect(
			projectProofClosure(
				summary({
					verdict: "inconclusive",
					unresolvedEffectIds: ["eff-1"],
					workspaceCompleteness: "partial_excluded",
					blockingClaimIds: ["a"],
				}),
			),
		).toMatchObject({ decision: "ESCALATE", causality: "Ambiguous", reasonCode: "proof.effect_frontier_open" });
		expect(
			projectProofClosure(
				summary({ verdict: "inconclusive", workspaceCompleteness: "partial_truncated", blockingClaimIds: ["a"] }),
			),
		).toMatchObject({
			decision: "INCONCLUSIVE_ENVIRONMENT",
			causality: "EnvironmentCaused",
			reasonCode: "proof.workspace_incomplete",
		});
		expect(projectProofClosure(summary({ verdict: "inconclusive", blockingClaimIds: ["a"] }))).toMatchObject({
			verdictState: "INDETERMINATE",
			decision: "ABSTAIN",
			causality: "Ambiguous",
			reasonCode: "proof.evidence_missing",
		});
	});

	it("projects an evaluation failure as a verifier error, never as a candidate verdict", () => {
		expect(projectProofEvaluationFailure()).toEqual({
			verdictState: "VERIFIER-ERROR",
			decision: "INCONCLUSIVE_ENVIRONMENT",
			causality: "EnvironmentCaused",
			reasonCode: "proof.evaluation_error",
		});
	});

	it("is total over the summary space and only SHIPs a verified proof", () => {
		fc.assert(
			fc.property(
				fc.record({
					verdict: fc.constantFrom("verified", "unverified", "inconclusive", "violated"),
					unresolvedEffectIds: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
					workspaceCompleteness: fc.constantFrom("complete", "partial_excluded", "partial_truncated", "unknown"),
					blockingClaimIds: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
				}) as fc.Arbitrary<ProofClosureSummary>,
				(value) => {
					const projected = projectProofClosure(value);
					expect(Object.isFrozen(projected)).toBe(true);
					expect(VERDICT_STATES).toContain(projected.verdictState);
					expect(isVeraVerificationDecision(projected.decision)).toBe(true);
					expect(isVeraEvidenceCausality(projected.causality)).toBe(true);
					expect(PROOF_PROJECTION_REASON_CODES).toContain(projected.reasonCode);
					expect(projected.decision === "SHIP").toBe(value.verdict === "verified");
					expect(projected.verdictState === "CONFIRMED").toBe(value.verdict === "verified");
					expect(projected.decision === "REJECT").toBe(value.verdict === "violated");
					if (value.verdict === "inconclusive" && value.unresolvedEffectIds.length > 0) {
						expect(projected.decision).toBe("ESCALATE");
					}
				},
			),
			{ numRuns: 300, seed: 0x0a0e0904 },
		);
	});
});

describe("admitVeraOutcome", () => {
	it("admits PASS as support and candidate failures as violations, including FLAKY", () => {
		expect(admitVeraOutcome("PASS")).toEqual({ admissible: true, polarity: "supports", causality: "NotApplicable" });
		for (const kind of ["FAIL", "CANDIDATE_ERROR", "FLAKY"] as const) {
			expect(admitVeraOutcome(kind)).toEqual({
				admissible: true,
				polarity: "violates",
				causality: "CandidateCaused",
			});
		}
	});

	it("keeps environment outcomes inadmissible so an outage never becomes a witness", () => {
		expect(admitVeraOutcome("ENV_ERROR")).toEqual({
			admissible: false,
			reason: "environment",
			causality: "EnvironmentCaused",
		});
		expect(admitVeraOutcome("TIMEOUT")).toEqual({ admissible: false, reason: "timeout", causality: "Ambiguous" });
		expect(admitVeraOutcome("AMBIGUOUS")).toEqual({ admissible: false, reason: "ambiguous", causality: "Ambiguous" });
		expect(admitVeraOutcome("SKIPPED")).toEqual({
			admissible: false,
			reason: "skipped",
			causality: "EnvironmentCaused",
		});
	});

	it("covers every engine outcome kind exactly once", () => {
		for (const kind of VERA_VERIFICATION_OUTCOME_KINDS) {
			const admission = admitVeraOutcome(kind);
			expect(isVeraEvidenceCausality(admission.causality)).toBe(true);
		}
		expect(() => admitVeraOutcome("BOGUS" as never)).toThrow(TypeError);
	});
});
