import type { EvaluationResult } from "omk-protocol";

export const ADVISORY_JUDGE_PROMPT_VERSION = "omk.advisory-judge.v1" as const;

export interface AdvisoryJudgeCriterion {
	readonly id: string;
	readonly description: string;
	readonly weight: number;
}

export interface AdvisoryJudgeCandidate {
	readonly id: string;
	readonly deterministicRank: number;
	readonly material: string;
	readonly evaluation: EvaluationResult;
}

export interface AdvisoryJudgeRequestCandidate {
	readonly id: string;
	readonly material: string;
	readonly materialSha256: string;
	readonly evaluationSha256: string;
}

export interface AdvisoryJudgeRequest {
	readonly promptVersion: typeof ADVISORY_JUDGE_PROMPT_VERSION;
	readonly taskId: string;
	readonly taskGoal: string;
	readonly rubric: readonly AdvisoryJudgeCriterion[];
	readonly candidates: readonly AdvisoryJudgeRequestCandidate[];
}

export type AdvisoryJudge = (request: AdvisoryJudgeRequest, signal?: AbortSignal) => Promise<unknown>;

export interface AdvisoryJudgeCandidateScore {
	readonly candidateId: string;
	readonly score: number;
}

export type AdvisoryJudgeDecisionStatus = "selected" | "fallback" | "skipped";
export type AdvisoryJudgeDecisionReason =
	| "judge-ranked"
	| "judge-tied"
	| "judge-unavailable"
	| "judge-response-invalid"
	| "single-eligible"
	| "no-eligible";

export interface AdvisoryJudgeDiagnostics {
	readonly submittedCandidates: number;
	readonly eligibleCandidates: number;
	readonly excludedCandidates: {
		readonly fail: number;
		readonly inconclusive: number;
	};
	readonly comparison: "not-compared" | "unavailable" | "invalid" | "scored";
	/** Present only for a complete score matrix; these are not correctness probabilities. */
	readonly ranking?: {
		readonly distinctScores: number;
		readonly topScoreTieCount: number;
		readonly scoreMargin: number;
	};
}

export interface AdvisoryJudgeDecision {
	readonly status: AdvisoryJudgeDecisionStatus;
	readonly reason: AdvisoryJudgeDecisionReason;
	readonly source: "llm-judge" | "deterministic" | "none";
	readonly judgeId: string;
	readonly taskId: string;
	readonly eligibleCandidateIds: readonly string[];
	readonly selectedCandidateId?: string;
	readonly candidateScores: readonly AdvisoryJudgeCandidateScore[];
	readonly requestSha256?: string;
	/** Optional for historical decisions; the built-in chooser always reports it. */
	readonly diagnostics?: AdvisoryJudgeDiagnostics;
}

export interface AdvisoryJudgeInput {
	readonly taskGoal: string;
	readonly judgeId: string;
	readonly judge: AdvisoryJudge;
	readonly rubric: readonly AdvisoryJudgeCriterion[];
	readonly candidates: readonly AdvisoryJudgeCandidate[];
	readonly signal?: AbortSignal;
}
