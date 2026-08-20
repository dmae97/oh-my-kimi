import { createHash } from "node:crypto";

export const DURABLE_GOAL_SCHEMA_VERSION = "omk.goal.v1" as const;
export const DURABLE_GOAL_STATUS_VALUES = ["active", "paused", "blocked", "completed", "cleared"] as const;

export type DurableGoalStatus = (typeof DURABLE_GOAL_STATUS_VALUES)[number];
export type DurableGoalErrorCode =
	| "evidence-required"
	| "illegal-transition"
	| "invalid-input"
	| "invalid-store"
	| "round-limit"
	| "stale-ref"
	| "store-exists"
	| "store-missing";

export interface DurableGoalRef {
	readonly id: string;
	readonly revision: number;
}

export interface DurableGoalEvidence {
	readonly id: string;
	readonly digest: string;
	readonly capturedAt: string;
	readonly goalGeneration: string;
}

export const DURABLE_GOAL_CHECKPOINT_SCHEMA_VERSION = "omk.goal.checkpoint.v1" as const;

export interface DurableGoalCheckpointInput {
	readonly core: readonly string[];
	readonly verifiedEvidenceIds: readonly string[];
	readonly open: readonly string[];
	readonly next: string;
	readonly capturedAt: string;
}

export interface DurableGoalCheckpoint extends DurableGoalCheckpointInput {
	readonly schemaVersion: typeof DURABLE_GOAL_CHECKPOINT_SCHEMA_VERSION;
	readonly goalGeneration: string;
	readonly digest: string;
}

export interface DurableGoalSnapshot {
	readonly schemaVersion: typeof DURABLE_GOAL_SCHEMA_VERSION;
	readonly ref: DurableGoalRef;
	readonly objective: string;
	readonly status: DurableGoalStatus;
	readonly maxRounds: number;
	readonly completedRounds: number;
	readonly evidence: readonly DurableGoalEvidence[];
	readonly createdAt: string;
	readonly generationStartedAt: string;
	readonly updatedAt: string;
	readonly checkpoint?: DurableGoalCheckpoint;
	readonly blockedReason?: string;
	readonly terminalAt?: string;
}

export type DurableGoalCommand =
	| { readonly kind: "edit"; readonly ref: DurableGoalRef; readonly objective?: string; readonly maxRounds?: number }
	| { readonly kind: "pause"; readonly ref: DurableGoalRef }
	| { readonly kind: "resume"; readonly ref: DurableGoalRef }
	| { readonly kind: "block"; readonly ref: DurableGoalRef; readonly reason: string }
	| { readonly kind: "advance-round"; readonly ref: DurableGoalRef }
	| {
			readonly kind: "record-checkpoint";
			readonly ref: DurableGoalRef;
			readonly checkpoint: DurableGoalCheckpointInput;
	  }
	| {
			readonly kind: "attach-evidence";
			readonly ref: DurableGoalRef;
			readonly evidence: { readonly id: string; readonly digest: string; readonly capturedAt: string };
	  }
	| { readonly kind: "complete"; readonly ref: DurableGoalRef }
	| { readonly kind: "clear"; readonly ref: DurableGoalRef };

export class DurableGoalError extends Error {
	readonly code: DurableGoalErrorCode;

	constructor(code: DurableGoalErrorCode, message: string) {
		super(message);
		this.name = "DurableGoalError";
		this.code = code;
	}
}

export function createDurableGoal(input: {
	readonly id: string;
	readonly objective: string;
	readonly maxRounds: number;
	readonly now: string;
}): DurableGoalSnapshot {
	return {
		schemaVersion: DURABLE_GOAL_SCHEMA_VERSION,
		ref: { id: requireText(input.id, "goal id"), revision: 1 },
		objective: requireText(input.objective, "goal objective"),
		status: "active",
		maxRounds: requirePositiveInteger(input.maxRounds, "maxRounds"),
		completedRounds: 0,
		evidence: [],
		createdAt: requireTimestamp(input.now, "now"),
		generationStartedAt: input.now,
		updatedAt: input.now,
	};
}

export function computeDurableGoalGeneration(goal: DurableGoalSnapshot): string {
	return createHash("sha256")
		.update(
			JSON.stringify([goal.ref.id, goal.objective, goal.maxRounds, goal.completedRounds, goal.generationStartedAt]),
		)
		.digest("hex");
}

export function freshDurableGoalEvidence(goal: DurableGoalSnapshot): readonly DurableGoalEvidence[] {
	const generation = computeDurableGoalGeneration(goal);
	const legacyInitialGeneration =
		goal.generationStartedAt === goal.createdAt ? computeLegacyDurableGoalGeneration(goal) : undefined;
	return goal.evidence.filter(
		(evidence) =>
			(evidence.goalGeneration === generation || evidence.goalGeneration === legacyInitialGeneration) &&
			Date.parse(evidence.capturedAt) >= Date.parse(goal.generationStartedAt) &&
			Date.parse(evidence.capturedAt) <= Date.parse(goal.updatedAt),
	);
}

function computeLegacyDurableGoalGeneration(goal: DurableGoalSnapshot): string {
	return createHash("sha256")
		.update(JSON.stringify([goal.ref.id, goal.objective, goal.maxRounds, goal.completedRounds]))
		.digest("hex");
}

function requireText(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new DurableGoalError("invalid-input", `${label} must not be empty`);
	return normalized;
}

function requirePositiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new DurableGoalError("invalid-input", `${label} must be a positive integer`);
	}
	return value;
}

function requireTimestamp(value: string, label: string): string {
	if (value.length === 0 || Number.isNaN(Date.parse(value))) {
		throw new DurableGoalError("invalid-input", `${label} must be an ISO timestamp`);
	}
	return value;
}
