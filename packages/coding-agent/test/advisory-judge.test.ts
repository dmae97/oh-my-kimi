import { type EvaluationResult, PROTOCOL_VERSION, type SemanticVerdict } from "omk-protocol";
import { describe, expect, it, vi } from "vitest";
import { type AdvisoryJudge, type AdvisoryJudgeRequest, chooseWithAdvisoryJudge } from "../src/index.ts";

const RUBRIC = [
	{ id: "correctness", description: "Satisfies the task and cited evidence", weight: 3 },
	{ id: "safety", description: "Preserves security and deterministic gates", weight: 2 },
] as const;

function evaluation(attemptId: string, semanticVerdict: SemanticVerdict): EvaluationResult {
	return {
		schemaVersion: PROTOCOL_VERSION,
		evaluationId: `evaluation-${attemptId}`,
		taskId: "task-1",
		attemptId,
		evaluatedAt: "2026-08-19T00:00:00.000Z",
		claims: [
			{
				claimId: "required-checks",
				requirement: "required",
				result: semanticVerdict === "pass" ? "satisfied" : semanticVerdict === "fail" ? "violated" : "inconclusive",
				reasonCode:
					semanticVerdict === "pass"
						? "claim.satisfied"
						: semanticVerdict === "fail"
							? "claim.violated"
							: "claim.observation_missing",
				observationIds: semanticVerdict === "inconclusive" ? [] : [`observation-${attemptId}`],
			},
		],
		semanticVerdict,
	};
}

function validScores(first: number, second: number): string {
	return JSON.stringify({
		scores: [
			{
				candidateId: "candidate-a",
				criteria: [
					{ criterionId: "correctness", score: first },
					{ criterionId: "safety", score: first },
				],
			},
			{
				candidateId: "candidate-b",
				criteria: [
					{ criterionId: "correctness", score: second },
					{ criterionId: "safety", score: second },
				],
			},
		],
	});
}

describe("advisory best-of-N judge", () => {
	it("admits only deterministic passes and redacts candidate material before the judge", async () => {
		let captured: AdvisoryJudgeRequest | undefined;
		const judge: AdvisoryJudge = async (request: AdvisoryJudgeRequest) => {
			captured = request;
			return validScores(2, 4);
		};
		const secret = `sk-${"x".repeat(24)}`;

		const decision = await chooseWithAdvisoryJudge({
			taskGoal: `Choose a patch; api_key=${secret}`,
			judgeId: "reviewer-1",
			judge,
			rubric: RUBRIC,
			candidates: [
				{
					id: "candidate-a",
					deterministicRank: 1,
					material: `safe A token=${secret}`,
					evaluation: evaluation("a", "pass"),
				},
				{ id: "candidate-b", deterministicRank: 2, material: "safe B", evaluation: evaluation("b", "pass") },
				{
					id: "candidate-failed",
					deterministicRank: 0,
					material: "failed candidate",
					evaluation: evaluation("f", "fail"),
				},
			],
		});

		expect(captured?.candidates.map((candidate: AdvisoryJudgeRequest["candidates"][number]) => candidate.id)).toEqual(
			["candidate-a", "candidate-b"],
		);
		expect(captured?.candidates.every((candidate) => /^[a-f0-9]{64}$/u.test(candidate.evaluationSha256))).toBe(true);
		expect(JSON.stringify(captured)).not.toContain(secret);
		expect(JSON.stringify(captured)).toContain("[REDACTED]");
		expect(decision).toMatchObject({
			status: "selected",
			reason: "judge-ranked",
			source: "llm-judge",
			selectedCandidateId: "candidate-b",
			eligibleCandidateIds: ["candidate-a", "candidate-b"],
		});
		expect(decision.candidateScores).toEqual([
			{ candidateId: "candidate-b", score: 4 },
			{ candidateId: "candidate-a", score: 2 },
		]);
	});

	it("falls back deterministically when the judge throws or returns malformed scores", async () => {
		const candidates = [
			{ id: "candidate-b", deterministicRank: 2, material: "B", evaluation: evaluation("b", "pass") },
			{ id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") },
		];
		const unavailable = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => {
				throw new Error("provider included secret-shaped diagnostics");
			},
			rubric: RUBRIC,
			candidates,
		});
		const malformed = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => '{"scores":[{"candidateId":"candidate-failed","criteria":[]}]}',
			rubric: RUBRIC,
			candidates,
		});
		const nonString = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => null,
			rubric: RUBRIC,
			candidates,
		});

		expect(unavailable).toMatchObject({
			status: "fallback",
			reason: "judge-unavailable",
			source: "deterministic",
			selectedCandidateId: "candidate-a",
		});
		expect(malformed).toMatchObject({
			status: "fallback",
			reason: "judge-response-invalid",
			source: "deterministic",
			selectedCandidateId: "candidate-a",
		});
		expect(nonString).toMatchObject({
			status: "fallback",
			reason: "judge-response-invalid",
			selectedCandidateId: "candidate-a",
		});
		expect(JSON.stringify(unavailable)).not.toContain("provider included");
	});

	it("uses deterministic order for score ties and skips the judge for zero or one eligible candidate", async () => {
		const tied = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge: async () => validScores(4, 4),
			rubric: RUBRIC,
			candidates: [
				{ id: "candidate-b", deterministicRank: 2, material: "B", evaluation: evaluation("b", "pass") },
				{ id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") },
			],
		});
		const judge = vi.fn<AdvisoryJudge>(async () => validScores(4, 4));
		const one = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge,
			rubric: RUBRIC,
			candidates: [
				{ id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") },
				{ id: "candidate-failed", deterministicRank: 0, material: "F", evaluation: evaluation("f", "fail") },
			],
		});
		const none = await chooseWithAdvisoryJudge({
			taskGoal: "Choose",
			judgeId: "reviewer-1",
			judge,
			rubric: RUBRIC,
			candidates: [
				{ id: "candidate-failed", deterministicRank: 0, material: "F", evaluation: evaluation("f", "fail") },
			],
		});

		expect(tied.selectedCandidateId).toBe("candidate-a");
		expect(one).toMatchObject({ status: "skipped", reason: "single-eligible", selectedCandidateId: "candidate-a" });
		expect(none).toMatchObject({ status: "skipped", reason: "no-eligible", source: "none" });
		expect(none.selectedCandidateId).toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
	});

	it("rejects duplicate IDs, ranks, and cross-task evaluation inputs before invoking the judge", async () => {
		const judge = vi.fn<AdvisoryJudge>(async () => validScores(4, 4));
		const base = { id: "candidate-a", deterministicRank: 1, material: "A", evaluation: evaluation("a", "pass") };
		const otherTask = { ...evaluation("b", "pass"), taskId: "task-2" };

		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [base, { ...base, evaluation: evaluation("b", "pass") }],
			}),
		).rejects.toThrow("candidate IDs must be unique");
		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [base, { ...base, id: "candidate-b", evaluation: evaluation("b", "pass") }],
			}),
		).rejects.toThrow("deterministic ranks must be unique");
		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [base, { ...base, id: "candidate-b", deterministicRank: 2, evaluation: otherTask }],
			}),
		).rejects.toThrow("one taskId");
		await expect(
			chooseWithAdvisoryJudge({
				taskGoal: "Choose",
				judgeId: "reviewer-1",
				judge,
				rubric: RUBRIC,
				candidates: [{ ...base, id: `sk-${"x".repeat(24)}` }],
			}),
		).rejects.toThrow("candidate id is invalid");
		expect(judge).not.toHaveBeenCalled();
	});
});
