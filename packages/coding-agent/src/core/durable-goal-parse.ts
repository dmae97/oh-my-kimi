import {
	DURABLE_GOAL_SCHEMA_VERSION,
	DURABLE_GOAL_STATUS_VALUES,
	DurableGoalError,
	type DurableGoalEvidence,
	type DurableGoalSnapshot,
	type DurableGoalStatus,
	freshDurableGoalEvidence,
} from "./durable-goal.ts";
import { parseDurableGoalCheckpoint } from "./durable-goal-checkpoint.ts";

export function parseDurableGoalSnapshot(value: unknown): DurableGoalSnapshot {
	if (!isRecord(value) || value.schemaVersion !== DURABLE_GOAL_SCHEMA_VERSION || !isRecord(value.ref)) {
		throw invalidStore();
	}
	const status = value.status;
	if (!isGoalStatus(status) || !Array.isArray(value.evidence)) throw invalidStore();
	const base: DurableGoalSnapshot = {
		schemaVersion: DURABLE_GOAL_SCHEMA_VERSION,
		ref: { id: requireText(value.ref.id), revision: requirePositiveInteger(value.ref.revision) },
		objective: requireText(value.objective),
		status,
		maxRounds: requirePositiveInteger(value.maxRounds),
		completedRounds: requireNonNegativeInteger(value.completedRounds),
		evidence: value.evidence.map(parseEvidence),
		createdAt: requireTimestamp(value.createdAt),
		generationStartedAt: requireTimestamp(value.generationStartedAt),
		updatedAt: requireTimestamp(value.updatedAt),
		...(value.blockedReason === undefined ? {} : { blockedReason: requireText(value.blockedReason) }),
		...(value.terminalAt === undefined ? {} : { terminalAt: requireTimestamp(value.terminalAt) }),
	};
	const snapshot: DurableGoalSnapshot =
		value.checkpoint === undefined
			? base
			: { ...base, checkpoint: parseDurableGoalCheckpoint(value.checkpoint, base) };
	if (snapshot.completedRounds > snapshot.maxRounds) throw invalidStore();
	if (Date.parse(snapshot.generationStartedAt) < Date.parse(snapshot.createdAt)) throw invalidStore();
	if (Date.parse(snapshot.generationStartedAt) > Date.parse(snapshot.updatedAt)) throw invalidStore();
	if ((snapshot.status === "blocked") !== (snapshot.blockedReason !== undefined)) throw invalidStore();
	if ((snapshot.status === "completed" || snapshot.status === "cleared") !== (snapshot.terminalAt !== undefined)) {
		throw invalidStore();
	}
	if (snapshot.status === "completed" && freshDurableGoalEvidence(snapshot).length === 0) throw invalidStore();
	return snapshot;
}

function parseEvidence(value: unknown): DurableGoalEvidence {
	if (!isRecord(value)) throw invalidStore();
	return {
		id: requireText(value.id),
		digest: requireDigest(value.digest),
		capturedAt: requireTimestamp(value.capturedAt),
		goalGeneration: requireDigest(value.goalGeneration),
	};
}

function requireText(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) throw invalidStore();
	return value;
}

function requirePositiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalidStore();
	return value;
}

function requireNonNegativeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidStore();
	return value;
}

function requireTimestamp(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) throw invalidStore();
	return value;
}

function requireDigest(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalidStore();
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is DurableGoalStatus {
	return typeof value === "string" && DURABLE_GOAL_STATUS_VALUES.some((status) => status === value);
}

function invalidStore(): DurableGoalError {
	return new DurableGoalError("invalid-store", "durable goal journal is invalid");
}
