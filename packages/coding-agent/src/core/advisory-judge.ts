import { createHash } from "node:crypto";
import { type EvaluationResult, parseEvaluationResult } from "omk-protocol";
import { advisoryWeightedScore, parseAdvisoryJudgeResponse } from "./advisory-judge-response.ts";
import {
	ADVISORY_JUDGE_PROMPT_VERSION,
	type AdvisoryJudgeCandidate,
	type AdvisoryJudgeCriterion,
	type AdvisoryJudgeDecision,
	type AdvisoryJudgeDiagnostics,
	type AdvisoryJudgeInput,
	type AdvisoryJudgeRequest,
} from "./advisory-judge-types.ts";
import { redactSensitiveTextForced } from "./redaction.ts";

export type {
	AdvisoryJudge,
	AdvisoryJudgeCandidate,
	AdvisoryJudgeCandidateScore,
	AdvisoryJudgeCriterion,
	AdvisoryJudgeDecision,
	AdvisoryJudgeDecisionReason,
	AdvisoryJudgeDecisionStatus,
	AdvisoryJudgeInput,
	AdvisoryJudgeRequest,
	AdvisoryJudgeRequestCandidate,
} from "./advisory-judge-types.ts";
export { ADVISORY_JUDGE_PROMPT_VERSION } from "./advisory-judge-types.ts";

const MAX_CANDIDATES = 8;
const MAX_CRITERIA = 8;
const MAX_MATERIAL_CHARS = 16_384;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_GOAL_CHARS = 2_048;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class AdvisoryJudgeInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisoryJudgeInputError";
	}
}

type DecisionBase = Pick<AdvisoryJudgeDecision, "judgeId" | "taskId" | "eligibleCandidateIds" | "candidateScores"> & {
	readonly diagnostics: AdvisoryJudgeDiagnostics;
};

export async function chooseWithAdvisoryJudge(input: AdvisoryJudgeInput): Promise<AdvisoryJudgeDecision> {
	const validated = validateInput(input);
	const eligible = validated.candidates.filter((candidate) => candidate.evaluation.semanticVerdict === "pass");
	const eligibleCandidateIds = eligible.map((candidate) => candidate.id);
	const base: DecisionBase = {
		judgeId: validated.judgeId,
		taskId: validated.taskId,
		eligibleCandidateIds,
		candidateScores: [],
		diagnostics: {
			submittedCandidates: validated.candidates.length,
			eligibleCandidates: eligible.length,
			excludedCandidates: {
				fail: validated.candidates.filter(({ evaluation }) => evaluation.semanticVerdict === "fail").length,
				inconclusive: validated.candidates.filter(({ evaluation }) => evaluation.semanticVerdict === "inconclusive")
					.length,
			},
			comparison: "not-compared",
		},
	};
	if (eligible.length === 0) return { ...base, status: "skipped", reason: "no-eligible", source: "none" };
	const fallbackId = eligible[0]?.id;
	if (fallbackId === undefined) throw new AdvisoryJudgeInputError("eligible candidate invariant failed");
	if (eligible.length === 1) {
		return {
			...base,
			status: "skipped",
			reason: "single-eligible",
			source: "deterministic",
			selectedCandidateId: fallbackId,
		};
	}

	const request = buildRequest(validated.taskId, validated.taskGoal, validated.rubric, eligible);
	const requestSha256 = sha256(JSON.stringify(request));
	if (input.signal?.aborted) return fallback(base, fallbackId, "judge-unavailable", requestSha256);
	let response: unknown;
	try {
		response = await input.judge(request, input.signal);
	} catch {
		return fallback(base, fallbackId, "judge-unavailable", requestSha256);
	}
	if (input.signal?.aborted) return fallback(base, fallbackId, "judge-unavailable", requestSha256);
	const parsed = parseAdvisoryJudgeResponse(response, eligibleCandidateIds, validated.rubric);
	if (parsed === null) return fallback(base, fallbackId, "judge-response-invalid", requestSha256);
	const rankById = new Map(eligible.map((candidate) => [candidate.id, candidate.deterministicRank]));
	const candidateScores = parsed
		.map((candidate) => ({
			candidateId: candidate.candidateId,
			score: advisoryWeightedScore(candidate, validated.rubric),
		}))
		.sort(
			(left, right) =>
				right.score - left.score ||
				(rankById.get(left.candidateId) ?? Number.MAX_SAFE_INTEGER) -
					(rankById.get(right.candidateId) ?? Number.MAX_SAFE_INTEGER) ||
				left.candidateId.localeCompare(right.candidateId),
		);
	const selected = candidateScores[0];
	if (selected === undefined) return fallback(base, fallbackId, "judge-response-invalid", requestSha256);
	const topScoreTieCount = candidateScores.filter(({ score }) => score === selected.score).length;
	return {
		...base,
		status: "selected",
		reason: topScoreTieCount > 1 ? "judge-tied" : "judge-ranked",
		source: topScoreTieCount > 1 ? "deterministic" : "llm-judge",
		selectedCandidateId: selected.candidateId,
		candidateScores,
		requestSha256,
		diagnostics: {
			...base.diagnostics,
			comparison: "scored",
			ranking: {
				distinctScores: new Set(candidateScores.map(({ score }) => score)).size,
				topScoreTieCount,
				scoreMargin: selected.score - (candidateScores[1]?.score ?? selected.score),
			},
		},
	};
}

function validateInput(input: AdvisoryJudgeInput): {
	readonly taskId: string;
	readonly taskGoal: string;
	readonly judgeId: string;
	readonly rubric: readonly AdvisoryJudgeCriterion[];
	readonly candidates: readonly AdvisoryJudgeCandidate[];
} {
	if (input.candidates.length === 0 || input.candidates.length > MAX_CANDIDATES) {
		throw new AdvisoryJudgeInputError(`candidates must contain 1-${MAX_CANDIDATES} entries`);
	}
	const ids = new Set<string>();
	const ranks = new Set<number>();
	const taskIds = new Set<string>();
	const candidates = input.candidates.map((candidate) => {
		const id = identifier(candidate.id, "candidate id");
		if (ids.has(id)) throw new AdvisoryJudgeInputError("candidate IDs must be unique");
		ids.add(id);
		if (!Number.isSafeInteger(candidate.deterministicRank) || candidate.deterministicRank < 0) {
			throw new AdvisoryJudgeInputError("deterministicRank must be a non-negative safe integer");
		}
		if (ranks.has(candidate.deterministicRank))
			throw new AdvisoryJudgeInputError("deterministic ranks must be unique");
		ranks.add(candidate.deterministicRank);
		const evaluation = parsedEvaluation(candidate.evaluation);
		taskIds.add(identifier(evaluation.taskId, "taskId"));
		return { ...candidate, id, evaluation };
	});
	if (taskIds.size !== 1) throw new AdvisoryJudgeInputError("candidate evaluations must reference one taskId");
	const taskId = candidates[0]?.evaluation.taskId;
	if (taskId === undefined) throw new AdvisoryJudgeInputError("candidate taskId is missing");
	return {
		taskId,
		taskGoal: boundedRedactedText(input.taskGoal, MAX_GOAL_CHARS, "taskGoal"),
		judgeId: identifier(input.judgeId, "judgeId"),
		rubric: validateRubric(input.rubric),
		candidates: candidates.sort(
			(left, right) => left.deterministicRank - right.deterministicRank || left.id.localeCompare(right.id),
		),
	};
}

function parsedEvaluation(value: EvaluationResult): EvaluationResult {
	try {
		return parseEvaluationResult(value);
	} catch {
		throw new AdvisoryJudgeInputError("candidate evaluation is invalid");
	}
}

function validateRubric(rubric: readonly AdvisoryJudgeCriterion[]): readonly AdvisoryJudgeCriterion[] {
	if (rubric.length === 0 || rubric.length > MAX_CRITERIA) {
		throw new AdvisoryJudgeInputError(`rubric must contain 1-${MAX_CRITERIA} criteria`);
	}
	const ids = new Set<string>();
	return rubric.map((criterion) => {
		const id = identifier(criterion.id, "criterion id");
		if (ids.has(id)) throw new AdvisoryJudgeInputError("criterion IDs must be unique");
		ids.add(id);
		if (!Number.isSafeInteger(criterion.weight) || criterion.weight < 1 || criterion.weight > 100) {
			throw new AdvisoryJudgeInputError("criterion weight must be an integer from 1 to 100");
		}
		return {
			id,
			description: boundedRedactedText(criterion.description, MAX_DESCRIPTION_CHARS, "criterion description"),
			weight: criterion.weight,
		};
	});
}

function buildRequest(
	taskId: string,
	taskGoal: string,
	rubric: readonly AdvisoryJudgeCriterion[],
	candidates: readonly AdvisoryJudgeCandidate[],
): AdvisoryJudgeRequest {
	return {
		promptVersion: ADVISORY_JUDGE_PROMPT_VERSION,
		taskId,
		taskGoal,
		rubric,
		candidates: candidates.map((candidate) => {
			const material = boundedRedactedText(candidate.material, MAX_MATERIAL_CHARS, "candidate material");
			return {
				id: candidate.id,
				material,
				materialSha256: sha256(material),
				evaluationSha256: sha256(JSON.stringify(candidate.evaluation)),
			};
		}),
	};
}

function fallback(
	base: DecisionBase,
	selectedCandidateId: string,
	reason: "judge-unavailable" | "judge-response-invalid",
	requestSha256: string,
): AdvisoryJudgeDecision {
	return {
		...base,
		status: "fallback",
		reason,
		source: "deterministic",
		selectedCandidateId,
		requestSha256,
		diagnostics: {
			...base.diagnostics,
			comparison: reason === "judge-unavailable" ? "unavailable" : "invalid",
		},
	};
}

function boundedRedactedText(value: string, maxChars: number, label: string): string {
	if (typeof value !== "string") throw new AdvisoryJudgeInputError(`${label} must be a string`);
	const redacted = redactSensitiveTextForced(value).trim();
	if (redacted.length === 0) throw new AdvisoryJudgeInputError(`${label} must not be empty`);
	return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars - 12)}[TRUNCATED]`;
}

function identifier(value: string, label: string): string {
	if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value) || redactSensitiveTextForced(value) !== value) {
		throw new AdvisoryJudgeInputError(`${label} is invalid`);
	}
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
