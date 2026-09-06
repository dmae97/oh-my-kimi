import { type EvaluationResult, PROTOCOL_VERSION, type SemanticVerdict } from "omk-protocol";
import type { AdvisoryJudgeCandidate, AdvisoryJudgeRequest } from "../src/index.ts";

export const RUBRIC = [{ id: "quality", description: "Prefer supported changes", weight: 1 }] as const;

const CLAIMS = {
	pass: { result: "satisfied", reasonCode: "claim.satisfied", observationIds: ["observation-1"] },
	fail: { result: "violated", reasonCode: "claim.violated", observationIds: ["observation-1"] },
	inconclusive: { result: "inconclusive", reasonCode: "claim.observation_missing", observationIds: [] },
} as const;

export function candidate(id: string, rank: number, verdict: SemanticVerdict = "pass"): AdvisoryJudgeCandidate {
	const evaluation: EvaluationResult = {
		schemaVersion: PROTOCOL_VERSION,
		evaluationId: `evaluation-${id}`,
		taskId: "task-1",
		attemptId: `attempt-${id}`,
		evaluatedAt: "2026-09-05T00:00:00.000Z",
		claims: [{ claimId: "checks", requirement: "required", ...CLAIMS[verdict] }],
		semanticVerdict: verdict,
	};
	return { id, deterministicRank: rank, material: `Patch ${id}`, evaluation };
}

export function scores(values: readonly (readonly [string, number])[]): string {
	return JSON.stringify({
		scores: values.map(([candidateId, score]) => ({
			candidateId,
			criteria: [{ criterionId: "quality", score }],
		})),
	});
}

export const CANDIDATES = [candidate("a", 0), candidate("b", 1)] as const;
export const RESPONSE = scores([
	["a", 1],
	["b", 4],
]);

export const REQUEST: AdvisoryJudgeRequest = {
	promptVersion: "omk.advisory-judge.v1",
	taskId: "task-1",
	taskGoal: "Compare the passing patches",
	rubric: RUBRIC,
	candidates: CANDIDATES.map(({ id, material }) => ({
		id,
		material,
		materialSha256: "a".repeat(64),
		evaluationSha256: "b".repeat(64),
	})),
};
