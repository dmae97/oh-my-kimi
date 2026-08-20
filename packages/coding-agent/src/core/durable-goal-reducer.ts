import {
	computeDurableGoalGeneration,
	type DurableGoalCheckpoint,
	type DurableGoalCommand,
	DurableGoalError,
	type DurableGoalEvidence,
	type DurableGoalRef,
	type DurableGoalSnapshot,
	type DurableGoalStatus,
	freshDurableGoalEvidence,
} from "./durable-goal.ts";
import { createDurableGoalCheckpoint } from "./durable-goal-checkpoint.ts";

export function applyDurableGoalCommand(
	current: DurableGoalSnapshot,
	command: DurableGoalCommand,
	now: string,
): DurableGoalSnapshot {
	requireCurrentRef(current, command.ref);
	requireMonotonicTimestamp(current, now);
	if (current.status === "cleared") throw illegal(current.status, command.kind);

	switch (command.kind) {
		case "edit":
			return editGoal(current, command, now);
		case "pause":
			if (current.status !== "active") throw illegal(current.status, command.kind);
			return revise(current, now, { status: "paused" });
		case "resume":
			if (current.status !== "paused" && current.status !== "blocked") throw illegal(current.status, command.kind);
			return revise(current, now, { status: "active", clearBlocked: true });
		case "block":
			if (current.status !== "active") throw illegal(current.status, command.kind);
			return revise(current, now, {
				status: "blocked",
				blockedReason: requireText(command.reason, "blocked reason"),
			});
		case "advance-round":
			return advanceRound(current, now);
		case "record-checkpoint":
			if (current.status === "completed") throw illegal(current.status, command.kind);
			return revise(current, now, { checkpoint: createDurableGoalCheckpoint(current, command.checkpoint, now) });
		case "attach-evidence":
			return attachEvidence(current, command, now);
		case "complete":
			return completeGoal(current, command.kind, now);
		case "clear":
			return revise(current, now, { status: "cleared", clearBlocked: true, terminalAt: now });
		default:
			return assertNever(command);
	}
}

function editGoal(
	current: DurableGoalSnapshot,
	command: Extract<DurableGoalCommand, { readonly kind: "edit" }>,
	now: string,
): DurableGoalSnapshot {
	if (current.status === "completed") throw illegal(current.status, command.kind);
	if (command.objective === undefined && command.maxRounds === undefined) {
		throw new DurableGoalError("invalid-input", "edit requires objective or maxRounds");
	}
	const objective =
		command.objective === undefined ? current.objective : requireText(command.objective, "goal objective");
	const maxRounds =
		command.maxRounds === undefined ? current.maxRounds : requirePositiveInteger(command.maxRounds, "maxRounds");
	if (maxRounds < current.completedRounds) {
		throw new DurableGoalError("invalid-input", "maxRounds cannot be below completedRounds");
	}
	const generationChanged = objective !== current.objective || maxRounds !== current.maxRounds;
	if (generationChanged) requireGenerationAdvance(current, now);
	return revise(current, now, {
		objective,
		maxRounds,
		...(generationChanged ? { generationStartedAt: now, clearCheckpoint: true } : {}),
	});
}

function advanceRound(current: DurableGoalSnapshot, now: string): DurableGoalSnapshot {
	if (current.status !== "active") throw illegal(current.status, "advance-round");
	if (current.completedRounds >= current.maxRounds) {
		throw new DurableGoalError("round-limit", "goal round limit reached");
	}
	requireGenerationAdvance(current, now);
	return revise(current, now, { completedRounds: current.completedRounds + 1, generationStartedAt: now });
}

function attachEvidence(
	current: DurableGoalSnapshot,
	command: Extract<DurableGoalCommand, { readonly kind: "attach-evidence" }>,
	now: string,
): DurableGoalSnapshot {
	if (current.status === "completed") throw illegal(current.status, command.kind);
	const capturedAt = requireTimestamp(command.evidence.capturedAt, "capturedAt");
	if (Date.parse(capturedAt) < Date.parse(current.generationStartedAt) || Date.parse(capturedAt) > Date.parse(now)) {
		throw new DurableGoalError("invalid-input", "evidence timestamp is outside current goal generation");
	}
	const evidence: DurableGoalEvidence = {
		id: requireText(command.evidence.id, "evidence id"),
		digest: requireDigest(command.evidence.digest),
		capturedAt,
		goalGeneration: computeDurableGoalGeneration(current),
	};
	return revise(current, now, { evidence: [...current.evidence, evidence] });
}

function completeGoal(
	current: DurableGoalSnapshot,
	command: Extract<DurableGoalCommand, { readonly kind: "complete" }>["kind"],
	now: string,
): DurableGoalSnapshot {
	if (current.status !== "active" && current.status !== "blocked") throw illegal(current.status, command);
	if (freshDurableGoalEvidence(current).length === 0) {
		throw new DurableGoalError("evidence-required", "fresh goal evidence is required");
	}
	return revise(current, now, { status: "completed", clearBlocked: true, terminalAt: now });
}

interface RevisionPatch {
	readonly objective?: string;
	readonly status?: DurableGoalStatus;
	readonly maxRounds?: number;
	readonly completedRounds?: number;
	readonly evidence?: readonly DurableGoalEvidence[];
	readonly checkpoint?: DurableGoalCheckpoint;
	readonly clearCheckpoint?: boolean;
	readonly generationStartedAt?: string;
	readonly blockedReason?: string;
	readonly clearBlocked?: boolean;
	readonly terminalAt?: string;
}

function revise(current: DurableGoalSnapshot, now: string, patch: RevisionPatch): DurableGoalSnapshot {
	return {
		schemaVersion: current.schemaVersion,
		ref: { id: current.ref.id, revision: current.ref.revision + 1 },
		objective: patch.objective ?? current.objective,
		status: patch.status ?? current.status,
		maxRounds: patch.maxRounds ?? current.maxRounds,
		completedRounds: patch.completedRounds ?? current.completedRounds,
		evidence: patch.evidence ?? current.evidence,
		...checkpointFields(current, patch),
		createdAt: current.createdAt,
		generationStartedAt: patch.generationStartedAt ?? current.generationStartedAt,
		updatedAt: now,
		...blockedFields(current, patch),
		...terminalFields(current, patch),
	};
}

function checkpointFields(
	current: DurableGoalSnapshot,
	patch: RevisionPatch,
): { readonly checkpoint?: DurableGoalCheckpoint } {
	if (patch.clearCheckpoint) return {};
	if (patch.checkpoint) return { checkpoint: patch.checkpoint };
	return current.checkpoint ? { checkpoint: current.checkpoint } : {};
}

function blockedFields(current: DurableGoalSnapshot, patch: RevisionPatch): { readonly blockedReason?: string } {
	if (patch.clearBlocked) return {};
	if (patch.blockedReason) return { blockedReason: patch.blockedReason };
	return current.blockedReason ? { blockedReason: current.blockedReason } : {};
}

function terminalFields(current: DurableGoalSnapshot, patch: RevisionPatch): { readonly terminalAt?: string } {
	if (patch.terminalAt) return { terminalAt: patch.terminalAt };
	return current.terminalAt ? { terminalAt: current.terminalAt } : {};
}

function requireCurrentRef(current: DurableGoalSnapshot, ref: DurableGoalRef): void {
	if (current.ref.id !== ref.id || current.ref.revision !== ref.revision) {
		throw new DurableGoalError("stale-ref", "goal reference is stale");
	}
}

function requireMonotonicTimestamp(current: DurableGoalSnapshot, now: string): void {
	requireTimestamp(now, "now");
	if (Date.parse(now) < Date.parse(current.updatedAt)) {
		throw new DurableGoalError("invalid-input", "goal timestamps must be monotonic");
	}
}

function requireGenerationAdvance(current: DurableGoalSnapshot, now: string): void {
	if (Date.parse(now) <= Date.parse(current.generationStartedAt)) {
		throw new DurableGoalError("invalid-input", "goal generation timestamp must advance");
	}
}

function requireText(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new DurableGoalError("invalid-input", `${label} must not be empty`);
	return normalized;
}

function requirePositiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new DurableGoalError("invalid-input", `${label} must be a positive integer`);
	return value;
}

function requireTimestamp(value: string, label: string): string {
	if (value.length === 0 || Number.isNaN(Date.parse(value))) {
		throw new DurableGoalError("invalid-input", `${label} must be an ISO timestamp`);
	}
	return value;
}

function requireDigest(value: string): string {
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new DurableGoalError("invalid-input", "evidence digest must be lowercase SHA-256");
	}
	return value;
}

function illegal(status: DurableGoalStatus, command: DurableGoalCommand["kind"]): DurableGoalError {
	return new DurableGoalError("illegal-transition", `cannot ${command} a ${status} goal`);
}

function assertNever(value: never): never {
	throw new DurableGoalError("invalid-input", `unsupported goal command: ${String(value)}`);
}
