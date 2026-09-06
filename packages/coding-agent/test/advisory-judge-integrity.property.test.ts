import * as fc from "fast-check";
import type { SemanticVerdict } from "omk-protocol";
import { describe, expect, it, vi } from "vitest";
import { type AdvisoryJudge, chooseWithAdvisoryJudge } from "../src/index.ts";
import { candidate, RUBRIC, scores } from "./advisory-judge-integrity-fixtures.ts";

const BASE = { taskGoal: "Compare passing patches", judgeId: "judge-1", rubric: RUBRIC } as const;
const CANDIDATES = [candidate("a", 0), candidate("b", 1), candidate("c", 2)];

const OPTIONS = { seed: 20260905, numRuns: 100 } as const;

describe("advisory selection invariants", () => {
	it("keeps caller priority when IDs sort in the opposite order", async () => {
		// Given transport and ID order both disagree with the explicit caller rank.
		const decision = await chooseWithAdvisoryJudge({
			...BASE,
			candidates: [candidate("a-second", 1), candidate("z-first", 0)],
			judge: async () =>
				scores([
					["a-second", 4],
					["z-first", 4],
				]),
		});
		// Then neither lexical identity nor arrival order replaces the caller's policy.
		expect(decision).toMatchObject({
			selectedCandidateId: "z-first",
			eligibleCandidateIds: ["z-first", "a-second"],
			reason: "judge-tied",
			source: "deterministic",
		});
	});

	it.each([
		{ quality: 2, safety: 0, winner: "b", reason: "judge-ranked", margin: 0.5, ties: 1 },
		{ quality: 1, safety: 1, winner: "a", reason: "judge-tied", margin: 0, ties: 2 },
	])("preserves weighted rubric semantics for $reason", async ({ quality, safety, winner, reason, margin, ties }) => {
		// Given criterion values whose weighted and unweighted rankings differ.
		const decision = await chooseWithAdvisoryJudge({
			...BASE,
			candidates: CANDIDATES.slice(0, 2),
			rubric: [
				{ ...RUBRIC[0], weight: 3 },
				{ id: "safety", description: "Preserve controls", weight: 1 },
			],
			judge: async () =>
				JSON.stringify({
					scores: [
						{
							candidateId: "a",
							criteria: [
								{ criterionId: "quality", score: 0 },
								{ criterionId: "safety", score: 4 },
							],
						},
						{
							candidateId: "b",
							criteria: [
								{ criterionId: "quality", score: quality },
								{ criterionId: "safety", score: safety },
							],
						},
					],
				}),
		});
		// Then attribution uses the weighted comparison, not a count or unweighted mean.
		expect(decision).toMatchObject({
			selectedCandidateId: winner,
			reason,
			diagnostics: { ranking: { topScoreTieCount: ties, scoreMargin: margin } },
		});
	});

	it("preserves the entire decision under candidate and response-row permutations", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 })),
				fc.shuffledSubarray(CANDIDATES, { minLength: 3, maxLength: 3 }),
				async ([a, b, c], shuffled) => {
					// Given fixed scores and caller ranks; only transport/list order changes.
					const forward = scores([
						["a", a],
						["b", b],
						["c", c],
					]);
					const reverse = scores([
						["c", c],
						["b", b],
						["a", a],
					]);
					const baseline = await chooseWithAdvisoryJudge({
						...BASE,
						candidates: CANDIDATES,
						judge: async () => forward,
					});
					// When the same evidence is permuted.
					const permuted = await chooseWithAdvisoryJudge({
						...BASE,
						candidates: shuffled,
						judge: async () => reverse,
					});
					// Then IDs, scores, diagnostics and canonical request identity are unchanged.
					expect(permuted).toEqual(baseline);
				},
			),
			OPTIONS,
		);
	});

	it("never promotes fail or inconclusive inputs and accounts for the complete intake", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom<SemanticVerdict>("pass", "fail", "inconclusive"), { minLength: 1, maxLength: 8 }),
				async (verdicts) => {
					// Given any permitted mixture of protocol outcomes.
					const candidates = verdicts.map((verdict, index) => candidate(`candidate-${index}`, index, verdict));
					const before = JSON.stringify(candidates);
					const judge = vi.fn<AdvisoryJudge>(async (request) =>
						scores(request.candidates.map(({ id }) => [id, 4])),
					);
					// When a judge gives maximum scores to everything it may see.
					const decision = await chooseWithAdvisoryJudge({ ...BASE, candidates, judge });
					// Then the deterministic gate, missingness and no-extra-call contract still hold.
					const passing = candidates.filter(({ evaluation }) => evaluation.semanticVerdict === "pass");
					expect(decision.eligibleCandidateIds).toEqual(passing.map(({ id }) => id));
					expect(decision.selectedCandidateId).toBe(passing[0]?.id);
					expect(judge).toHaveBeenCalledTimes(passing.length > 1 ? 1 : 0);
					expect(decision.diagnostics).toMatchObject({
						submittedCandidates: candidates.length,
						eligibleCandidates: passing.length,
						excludedCandidates: {
							fail: verdicts.filter((verdict) => verdict === "fail").length,
							inconclusive: verdicts.filter((verdict) => verdict === "inconclusive").length,
						},
					});
					expect(JSON.stringify(candidates)).toBe(before);
				},
			),
			OPTIONS,
		);
	});
});
