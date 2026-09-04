import {
	type ProofClosureSummary,
	projectProofClosure,
	projectProofEvaluationFailure,
	VERA_VERIFICATION_DECISIONS,
} from "omk-adaptorch-wpl";
import {
	CLAIM_GRAPH_SCHEMA_VERSION,
	type ClaimGraph,
	ClaimGraphError,
	evaluateProofClosure,
	type ProofClosureInput,
	type ProofClosureResult,
} from "omk-protocol";
import { describe, expect, it } from "vitest";

/**
 * `omk-adaptorch-wpl` cannot depend on `omk-protocol`, so its
 * `ProofClosureSummary` is a structural copy of the fields it projects. This
 * package depends on both; the assignment below is the compile-time parity
 * gate (tsgo fails if the shapes diverge) and the cases are the runtime one.
 */
const _shapeParity: (result: ProofClosureResult) => ProofClosureSummary = (result) => result;

const graph: ClaimGraph = {
	schemaVersion: CLAIM_GRAPH_SCHEMA_VERSION,
	claims: [
		{
			claimId: "tests.pass",
			kind: "requirement",
			statement: "targeted tests pass",
			severity: "required",
			satisfaction: { rule: "all", inputs: [] },
			trustFloor: "deterministic_validator",
			invalidationKeys: [],
		},
	],
};

function input(patch: Partial<ProofClosureInput> = {}): ProofClosureInput {
	return {
		graph,
		observations: [],
		waivers: [],
		sourceRoot: "sha256:root",
		environmentDigest: "sha256:env",
		workspaceCompleteness: "complete",
		unresolvedEffectIds: [],
		now: "2026-09-04T12:00:00.000Z",
		...patch,
	};
}

const witness = {
	observationId: "o1",
	claimIds: ["tests.pass"],
	polarity: "supports" as const,
	source: "deterministic_validator" as const,
	sourceRoot: "sha256:root",
	environmentDigest: "sha256:env",
};

describe("proof closure → AdaptOrch projection parity", () => {
	it("accepts a protocol result by shape and ships only a verified closure", () => {
		const verified = evaluateProofClosure(input({ observations: [witness] }));
		expect(_shapeParity(verified)).toBe(verified);
		expect(projectProofClosure(verified)).toMatchObject({ verdictState: "CONFIRMED", decision: "SHIP" });
	});

	it("routes counterexamples, open effects, partial scope, and missing evidence to distinct decisions", () => {
		const violated = evaluateProofClosure(input({ observations: [{ ...witness, polarity: "violates" }] }));
		expect(projectProofClosure(violated)).toMatchObject({ verdictState: "CONTRADICTED", decision: "REJECT" });

		const openEffect = evaluateProofClosure(input({ observations: [witness], unresolvedEffectIds: ["eff-1"] }));
		expect(projectProofClosure(openEffect)).toMatchObject({
			decision: "ESCALATE",
			reasonCode: "proof.effect_frontier_open",
		});

		const partial = evaluateProofClosure(
			input({ observations: [witness], workspaceCompleteness: "partial_excluded" }),
		);
		expect(projectProofClosure(partial)).toMatchObject({ decision: "INCONCLUSIVE_ENVIRONMENT" });

		const missing = evaluateProofClosure(input());
		expect(projectProofClosure(missing)).toMatchObject({ decision: "ABSTAIN", reasonCode: "proof.evidence_missing" });
	});

	it("turns an evaluation error into a verifier error instead of a candidate verdict", () => {
		const broken: ClaimGraph = { ...graph, claims: [...graph.claims, ...graph.claims] };
		let projection = projectProofClosure(evaluateProofClosure(input({ observations: [witness] })));
		try {
			evaluateProofClosure(input({ graph: broken }));
		} catch (error) {
			expect(error).toBeInstanceOf(ClaimGraphError);
			projection = projectProofEvaluationFailure();
		}
		expect(projection.verdictState).toBe("VERIFIER-ERROR");
		expect(VERA_VERIFICATION_DECISIONS).toContain(projection.decision);
	});
});
