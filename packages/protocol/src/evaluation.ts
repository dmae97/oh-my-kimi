import {
	type ClaimCondition,
	type ClaimEvaluation,
	type ClaimResult,
	type EvaluationInput,
	type EvaluationResult,
	type JsonValue,
	type Observation,
	PROTOCOL_VERSION,
	type SemanticVerdict,
	type WaiverRecord,
} from "./types.ts";
import {
	parseEvaluationResult,
	parseExecutionAttempt,
	parseObservation,
	parseTaskSpec,
	parseWaiverRecord,
} from "./validation.ts";

export class ProtocolInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolInvariantError";
	}
}

interface ConditionResult {
	readonly result: ClaimResult;
	readonly observationIds: readonly string[];
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesExpected(actual: JsonValue | undefined, expected: JsonValue): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((value, index) => matchesExpected(actual[index], value))
		);
	}
	if (isObject(expected)) {
		return (
			actual !== undefined &&
			isObject(actual) &&
			Object.entries(expected).every(([key, value]) => matchesExpected(actual[key], value))
		);
	}
	return Object.is(actual, expected);
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}

function evaluateCondition(
	condition: ClaimCondition,
	observations: readonly Observation[],
	attemptId: string,
): ConditionResult {
	if (condition.kind === "observation") {
		const candidates = observations.filter(
			(observation) =>
				observation.kind === condition.observationKind &&
				(condition.scope === "task" || observation.attemptId === attemptId),
		);
		if (candidates.length === 0) return { result: "inconclusive", observationIds: [] };
		const matching = candidates.filter((observation) => matchesExpected(observation.facts, condition.facts));
		return matching.length > 0
			? { result: "satisfied", observationIds: matching.map(({ observationId }) => observationId) }
			: { result: "violated", observationIds: candidates.map(({ observationId }) => observationId) };
	}

	if (condition.kind === "not") {
		const child = evaluateCondition(condition.condition, observations, attemptId);
		return {
			result: child.result === "satisfied" ? "violated" : child.result === "violated" ? "satisfied" : "inconclusive",
			observationIds: child.observationIds,
		};
	}

	const children = condition.conditions.map((child) => evaluateCondition(child, observations, attemptId));
	if (condition.kind === "all") {
		const result = children.some((child) => child.result === "violated")
			? "violated"
			: children.some((child) => child.result === "inconclusive")
				? "inconclusive"
				: "satisfied";
		return { result, observationIds: unique(children.flatMap(({ observationIds }) => observationIds)) };
	}
	const result = children.some((child) => child.result === "satisfied")
		? "satisfied"
		: children.every((child) => child.result === "violated")
			? "violated"
			: "inconclusive";
	return { result, observationIds: unique(children.flatMap(({ observationIds }) => observationIds)) };
}

function reasonCode(result: ClaimResult): ClaimEvaluation["reasonCode"] {
	if (result === "satisfied") return "claim.satisfied";
	if (result === "violated") return "claim.violated";
	return "claim.observation_missing";
}

function validateWaivers(input: EvaluationInput, waivers: readonly WaiverRecord[]): ReadonlyMap<string, WaiverRecord> {
	const claims = new Map(input.taskSpec.claims.map((claim) => [claim.claimId, claim]));
	const byClaim = new Map<string, WaiverRecord>();
	for (const waiver of waivers) {
		parseWaiverRecord(waiver);
		if (waiver.scope.taskId !== input.taskSpec.taskId) {
			throw new ProtocolInvariantError(`${waiver.waiverId} targets task ${waiver.scope.taskId}`);
		}
		const claim = claims.get(waiver.scope.claimId);
		if (!claim) throw new ProtocolInvariantError(`${waiver.waiverId} targets unknown claim ${waiver.scope.claimId}`);
		if (claim.requirement !== "required") {
			throw new ProtocolInvariantError(`${waiver.waiverId} cannot waive advisory claim ${claim.claimId}`);
		}
		if (waiver.scope.attemptId !== undefined && waiver.scope.attemptId !== input.attempt.attemptId) {
			throw new ProtocolInvariantError(`${waiver.waiverId} targets attempt ${waiver.scope.attemptId}`);
		}
		if (waiver.approvedAt > input.evaluatedAt) {
			throw new ProtocolInvariantError(`${waiver.waiverId} was approved after evaluation`);
		}
		if (waiver.expiresAt !== undefined && waiver.expiresAt <= input.evaluatedAt) {
			throw new ProtocolInvariantError(`${waiver.waiverId} is expired`);
		}
		if (byClaim.has(claim.claimId))
			throw new ProtocolInvariantError(`multiple waivers target claim ${claim.claimId}`);
		byClaim.set(claim.claimId, waiver);
	}
	return byClaim;
}

function reduceVerdict(claims: readonly ClaimEvaluation[]): SemanticVerdict {
	const required = claims.filter((claim) => claim.requirement === "required" && claim.waiverId === undefined);
	if (required.length === 0) return claims.some((claim) => claim.requirement === "required") ? "pass" : "inconclusive";
	if (required.some((claim) => claim.result === "violated")) return "fail";
	if (required.some((claim) => claim.result === "inconclusive")) return "inconclusive";
	return "pass";
}

/** Pure TaskSpec -> Observation -> Evaluation reduction. */
export function evaluateTask(input: EvaluationInput): EvaluationResult {
	parseTaskSpec(input.taskSpec);
	parseExecutionAttempt(input.attempt);
	if (input.attempt.taskId !== input.taskSpec.taskId) {
		throw new ProtocolInvariantError(`${input.attempt.attemptId} targets task ${input.attempt.taskId}`);
	}
	for (const observation of input.observations) {
		parseObservation(observation);
		if (observation.taskId !== input.taskSpec.taskId) {
			throw new ProtocolInvariantError(`${observation.observationId} targets task ${observation.taskId}`);
		}
	}
	const waivers = validateWaivers(input, input.waivers ?? []);
	const claims = Object.freeze(
		input.taskSpec.claims.map((claim): ClaimEvaluation => {
			const evaluated = evaluateCondition(claim.condition, input.observations, input.attempt.attemptId);
			const waiver = evaluated.result === "satisfied" ? undefined : waivers.get(claim.claimId);
			return Object.freeze({
				claimId: claim.claimId,
				requirement: claim.requirement,
				result: evaluated.result,
				reasonCode: reasonCode(evaluated.result),
				observationIds: Object.freeze([...evaluated.observationIds]),
				...(waiver ? { waiverId: waiver.waiverId } : {}),
			});
		}),
	);
	return parseEvaluationResult(
		Object.freeze({
			schemaVersion: PROTOCOL_VERSION,
			evaluationId: input.evaluationId,
			taskId: input.taskSpec.taskId,
			attemptId: input.attempt.attemptId,
			evaluatedAt: input.evaluatedAt,
			claims,
			semanticVerdict: reduceVerdict(claims),
		}),
	);
}
