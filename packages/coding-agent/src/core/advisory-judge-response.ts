import type { AdvisoryJudgeCriterion } from "./advisory-judge-types.ts";
import { isExactRecord } from "./strict-record.ts";

export interface ParsedAdvisoryCandidateScore {
	readonly candidateId: string;
	readonly criteria: ReadonlyMap<string, number>;
}

export function parseAdvisoryJudgeResponse(
	response: unknown,
	candidateIds: readonly string[],
	rubric: readonly AdvisoryJudgeCriterion[],
): readonly ParsedAdvisoryCandidateScore[] | null {
	if (typeof response !== "string" || response.length === 0 || response.length > 65_536) return null;
	let value: unknown;
	try {
		value = JSON.parse(response);
	} catch {
		return null;
	}
	if (
		!isExactRecord(value, ["scores"]) ||
		!Array.isArray(value.scores) ||
		value.scores.length !== candidateIds.length
	) {
		return null;
	}
	const expectedCandidates = new Set(candidateIds);
	const expectedCriteria = new Set(rubric.map((criterion) => criterion.id));
	const seenCandidates = new Set<string>();
	const parsed: ParsedAdvisoryCandidateScore[] = [];
	for (const score of value.scores) {
		const candidate = parseCandidateScore(score, expectedCandidates, expectedCriteria, rubric.length);
		if (candidate === null || seenCandidates.has(candidate.candidateId)) return null;
		seenCandidates.add(candidate.candidateId);
		parsed.push(candidate);
	}
	return parsed;
}

export function advisoryWeightedScore(
	candidate: ParsedAdvisoryCandidateScore,
	rubric: readonly AdvisoryJudgeCriterion[],
): number {
	const totalWeight = rubric.reduce((sum, criterion) => sum + criterion.weight, 0);
	return (
		rubric.reduce((sum, criterion) => sum + (candidate.criteria.get(criterion.id) ?? 0) * criterion.weight, 0) /
		totalWeight
	);
}

function parseCandidateScore(
	value: unknown,
	expectedCandidates: ReadonlySet<string>,
	expectedCriteria: ReadonlySet<string>,
	criterionCount: number,
): ParsedAdvisoryCandidateScore | null {
	if (!isExactRecord(value, ["candidateId", "criteria"]) || typeof value.candidateId !== "string") return null;
	if (
		!expectedCandidates.has(value.candidateId) ||
		!Array.isArray(value.criteria) ||
		value.criteria.length !== criterionCount
	) {
		return null;
	}
	const criteria = new Map<string, number>();
	for (const criterion of value.criteria) {
		if (!addCriterionScore(criterion, expectedCriteria, criteria)) return null;
	}
	return { candidateId: value.candidateId, criteria };
}

function addCriterionScore(
	value: unknown,
	expectedCriteria: ReadonlySet<string>,
	criteria: Map<string, number>,
): boolean {
	if (!isExactRecord(value, ["criterionId", "score"]) || typeof value.criterionId !== "string") return false;
	if (!expectedCriteria.has(value.criterionId) || criteria.has(value.criterionId)) return false;
	if (typeof value.score !== "number" || !Number.isSafeInteger(value.score) || value.score < 0 || value.score > 4) {
		return false;
	}
	criteria.set(value.criterionId, value.score);
	return true;
}
