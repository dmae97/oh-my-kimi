import {
	type ClaimCondition,
	type EvaluationResult,
	type ExecutionAttempt,
	type JsonObject,
	type JsonValue,
	type Observation,
	PROTOCOL_VERSION,
	type RuntimeDecision,
	type TaskSpec,
	type WaiverRecord,
} from "./types.ts";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_CONDITION_DEPTH = 32;

export class ProtocolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolValidationError";
	}
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ProtocolValidationError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProtocolValidationError(`${path} must be a non-empty string`);
	}
	return value;
}

function timestamp(value: unknown, path: string): string {
	const parsed = string(value, path);
	if (!ISO_TIMESTAMP.test(parsed) || Number.isNaN(Date.parse(parsed))) {
		throw new ProtocolValidationError(`${path} must be an ISO 8601 UTC timestamp`);
	}
	return parsed;
}

function version(value: Record<string, unknown>, path: string): void {
	if (value.schemaVersion !== PROTOCOL_VERSION) {
		throw new ProtocolValidationError(`${path}.schemaVersion must be ${PROTOCOL_VERSION}`);
	}
}

function stringArray(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value)) throw new ProtocolValidationError(`${path} must be an array`);
	return value.map((item, index) => string(item, `${path}[${index}]`));
}

function jsonValue(value: unknown, path: string, depth = 0): asserts value is JsonValue {
	if (depth > MAX_CONDITION_DEPTH) throw new ProtocolValidationError(`${path} exceeds maximum nesting depth`);
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			jsonValue(item, `${path}[${index}]`, depth + 1);
		});
		return;
	}
	const object = record(value, path);
	for (const [key, item] of Object.entries(object)) jsonValue(item, `${path}.${key}`, depth + 1);
}

function jsonObject(value: unknown, path: string): asserts value is JsonObject {
	record(value, path);
	jsonValue(value, path);
}

function condition(value: unknown, path: string, depth = 0): asserts value is ClaimCondition {
	if (depth > MAX_CONDITION_DEPTH) throw new ProtocolValidationError(`${path} exceeds maximum nesting depth`);
	const input = record(value, path);
	switch (input.kind) {
		case "observation":
			string(input.observationKind, `${path}.observationKind`);
			if (input.scope !== "attempt" && input.scope !== "task") {
				throw new ProtocolValidationError(`${path}.scope must be attempt or task`);
			}
			jsonObject(input.facts, `${path}.facts`);
			return;
		case "all":
		case "any":
			if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
				throw new ProtocolValidationError(`${path}.conditions must be a non-empty array`);
			}
			input.conditions.forEach((item, index) => {
				condition(item, `${path}.conditions[${index}]`, depth + 1);
			});
			return;
		case "not":
			condition(input.condition, `${path}.condition`, depth + 1);
			return;
		default:
			throw new ProtocolValidationError(`${path}.kind is unsupported`);
	}
}

export function parseTaskSpec(value: unknown): TaskSpec {
	const input = record(value, "taskSpec");
	version(input, "taskSpec");
	string(input.taskId, "taskSpec.taskId");
	string(input.goal, "taskSpec.goal");
	timestamp(input.createdAt, "taskSpec.createdAt");
	if (!Array.isArray(input.claims)) throw new ProtocolValidationError("taskSpec.claims must be an array");
	const claimIds = new Set<string>();
	for (const [index, rawClaim] of input.claims.entries()) {
		const claim = record(rawClaim, `taskSpec.claims[${index}]`);
		const claimId = string(claim.claimId, `taskSpec.claims[${index}].claimId`);
		if (claimIds.has(claimId)) throw new ProtocolValidationError(`duplicate claimId ${claimId}`);
		claimIds.add(claimId);
		string(claim.statement, `taskSpec.claims[${index}].statement`);
		if (claim.requirement !== "required" && claim.requirement !== "advisory") {
			throw new ProtocolValidationError(`taskSpec.claims[${index}].requirement is unsupported`);
		}
		condition(claim.condition, `taskSpec.claims[${index}].condition`);
	}
	return value as TaskSpec;
}

export function parseExecutionAttempt(value: unknown): ExecutionAttempt {
	const input = record(value, "attempt");
	version(input, "attempt");
	string(input.attemptId, "attempt.attemptId");
	string(input.taskId, "attempt.taskId");
	if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) {
		throw new ProtocolValidationError("attempt.sequence must be a positive integer");
	}
	if (!["initial", "retry", "failover", "resume"].includes(input.trigger as string)) {
		throw new ProtocolValidationError("attempt.trigger is unsupported");
	}
	if (input.previousAttemptId !== undefined) string(input.previousAttemptId, "attempt.previousAttemptId");
	const startedAt = timestamp(input.startedAt, "attempt.startedAt");
	const finishedAt = timestamp(input.finishedAt, "attempt.finishedAt");
	if (finishedAt < startedAt) throw new ProtocolValidationError("attempt.finishedAt precedes startedAt");
	const executor = record(input.executor, "attempt.executor");
	string(executor.kind, "attempt.executor.kind");
	if (executor.provider !== undefined) string(executor.provider, "attempt.executor.provider");
	if (executor.model !== undefined) string(executor.model, "attempt.executor.model");
	const outcome = record(input.outcome, "attempt.outcome");
	if (outcome.kind === "failed") {
		string(outcome.code, "attempt.outcome.code");
		if (outcome.message !== undefined) string(outcome.message, "attempt.outcome.message");
	} else if (outcome.kind === "cancelled") {
		string(outcome.code, "attempt.outcome.code");
	} else if (outcome.kind !== "completed") {
		throw new ProtocolValidationError("attempt.outcome.kind is unsupported");
	}
	return value as ExecutionAttempt;
}

export function parseObservation(value: unknown): Observation {
	const input = record(value, "observation");
	version(input, "observation");
	string(input.observationId, "observation.observationId");
	string(input.taskId, "observation.taskId");
	string(input.attemptId, "observation.attemptId");
	timestamp(input.observedAt, "observation.observedAt");
	string(input.kind, "observation.kind");
	const source = record(input.source, "observation.source");
	string(source.kind, "observation.source.kind");
	string(source.id, "observation.source.id");
	jsonObject(input.facts, "observation.facts");
	stringArray(input.evidenceRefs, "observation.evidenceRefs");
	return value as Observation;
}

export function parseWaiverRecord(value: unknown): WaiverRecord {
	const input = record(value, "waiver");
	version(input, "waiver");
	string(input.waiverId, "waiver.waiverId");
	const scope = record(input.scope, "waiver.scope");
	string(scope.taskId, "waiver.scope.taskId");
	string(scope.claimId, "waiver.scope.claimId");
	if (scope.attemptId !== undefined) string(scope.attemptId, "waiver.scope.attemptId");
	string(input.approvedBy, "waiver.approvedBy");
	timestamp(input.approvedAt, "waiver.approvedAt");
	if (input.expiresAt !== undefined) timestamp(input.expiresAt, "waiver.expiresAt");
	string(input.rationale, "waiver.rationale");
	stringArray(input.evidenceRefs, "waiver.evidenceRefs");
	return value as WaiverRecord;
}

export function parseEvaluationResult(value: unknown): EvaluationResult {
	const input = record(value, "evaluation");
	version(input, "evaluation");
	string(input.evaluationId, "evaluation.evaluationId");
	string(input.taskId, "evaluation.taskId");
	string(input.attemptId, "evaluation.attemptId");
	timestamp(input.evaluatedAt, "evaluation.evaluatedAt");
	if (!Array.isArray(input.claims)) throw new ProtocolValidationError("evaluation.claims must be an array");
	for (const [index, rawClaim] of input.claims.entries()) {
		const claim = record(rawClaim, `evaluation.claims[${index}]`);
		string(claim.claimId, `evaluation.claims[${index}].claimId`);
		if (claim.requirement !== "required" && claim.requirement !== "advisory") {
			throw new ProtocolValidationError(`evaluation.claims[${index}].requirement is unsupported`);
		}
		if (!["satisfied", "violated", "inconclusive"].includes(claim.result as string)) {
			throw new ProtocolValidationError(`evaluation.claims[${index}].result is unsupported`);
		}
		if (!["claim.satisfied", "claim.violated", "claim.observation_missing"].includes(claim.reasonCode as string)) {
			throw new ProtocolValidationError(`evaluation.claims[${index}].reasonCode is unsupported`);
		}
		stringArray(claim.observationIds, `evaluation.claims[${index}].observationIds`);
		if (claim.waiverId !== undefined) string(claim.waiverId, `evaluation.claims[${index}].waiverId`);
	}
	if (!["pass", "fail", "inconclusive"].includes(input.semanticVerdict as string)) {
		throw new ProtocolValidationError("evaluation.semanticVerdict is unsupported");
	}
	return value as EvaluationResult;
}

export function parseRuntimeDecision(value: unknown): RuntimeDecision {
	const input = record(value, "decision");
	version(input, "decision");
	string(input.decisionId, "decision.decisionId");
	string(input.taskId, "decision.taskId");
	string(input.attemptId, "decision.attemptId");
	string(input.evaluationId, "decision.evaluationId");
	timestamp(input.decidedAt, "decision.decidedAt");
	if (!["continue", "retry", "failover", "stop"].includes(input.action as string)) {
		throw new ProtocolValidationError("decision.action is unsupported");
	}
	if (!["evaluation.pass", "evaluation.fail", "evaluation.inconclusive"].includes(input.reasonCode as string)) {
		throw new ProtocolValidationError("decision.reasonCode is unsupported");
	}
	return value as RuntimeDecision;
}
