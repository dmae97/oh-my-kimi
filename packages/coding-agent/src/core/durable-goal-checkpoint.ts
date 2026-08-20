import { createHash } from "node:crypto";
import {
	computeDurableGoalGeneration,
	DURABLE_GOAL_CHECKPOINT_SCHEMA_VERSION,
	type DurableGoalCheckpoint,
	type DurableGoalCheckpointInput,
	DurableGoalError,
	type DurableGoalSnapshot,
	freshDurableGoalEvidence,
} from "./durable-goal.ts";
import { redactSensitiveTextForced } from "./redaction.ts";
import { isExactRecord } from "./strict-record.ts";

const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 512;
const MAX_NEXT_CHARS = 1_024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export function createDurableGoalCheckpoint(
	goal: DurableGoalSnapshot,
	input: DurableGoalCheckpointInput,
	now: string,
): DurableGoalCheckpoint {
	const capturedAt = timestamp(input.capturedAt, "checkpoint capturedAt");
	if (Date.parse(capturedAt) < Date.parse(goal.generationStartedAt) || Date.parse(capturedAt) > Date.parse(now)) {
		throw new DurableGoalError("invalid-input", "checkpoint timestamp is outside current goal generation");
	}
	const verifiedEvidenceIds = evidenceIds(input.verifiedEvidenceIds, "invalid-input");
	const freshEvidence = freshDurableGoalEvidence(goal);
	if (
		verifiedEvidenceIds.some((id) => {
			const evidence = freshEvidence.find((candidate) => candidate.id === id);
			return !evidence || Date.parse(evidence.capturedAt) > Date.parse(capturedAt);
		})
	) {
		throw new DurableGoalError("invalid-input", "checkpoint evidence must reference fresh goal evidence");
	}
	return seal({
		schemaVersion: DURABLE_GOAL_CHECKPOINT_SCHEMA_VERSION,
		goalGeneration: computeDurableGoalGeneration(goal),
		core: textList(input.core, "checkpoint core", "invalid-input"),
		verifiedEvidenceIds,
		open: textList(input.open, "checkpoint open", "invalid-input"),
		next: text(input.next, MAX_NEXT_CHARS, "checkpoint next", "invalid-input"),
		capturedAt,
	});
}

export function parseDurableGoalCheckpoint(value: unknown, goal: DurableGoalSnapshot): DurableGoalCheckpoint {
	if (
		!isExactRecord(value, [
			"schemaVersion",
			"goalGeneration",
			"core",
			"verifiedEvidenceIds",
			"open",
			"next",
			"capturedAt",
			"digest",
		])
	) {
		throw invalidStore();
	}
	if (
		value.schemaVersion !== DURABLE_GOAL_CHECKPOINT_SCHEMA_VERSION ||
		!DIGEST_PATTERN.test(stringValue(value.goalGeneration))
	) {
		throw invalidStore();
	}
	const capturedAt = persistedTimestamp(value.capturedAt);
	if (Date.parse(capturedAt) < Date.parse(goal.createdAt) || Date.parse(capturedAt) > Date.parse(goal.updatedAt)) {
		throw invalidStore();
	}
	const material = {
		schemaVersion: DURABLE_GOAL_CHECKPOINT_SCHEMA_VERSION,
		goalGeneration: stringValue(value.goalGeneration),
		core: persistedTextList(value.core),
		verifiedEvidenceIds: persistedEvidenceIds(value.verifiedEvidenceIds),
		open: persistedTextList(value.open),
		next: persistedText(value.next, MAX_NEXT_CHARS),
		capturedAt,
	};
	const checkpoint = seal(material);
	if (checkpoint.digest !== value.digest) throw invalidStore();
	for (const id of checkpoint.verifiedEvidenceIds) {
		const evidence = goal.evidence.find(
			(candidate) => candidate.id === id && candidate.goalGeneration === checkpoint.goalGeneration,
		);
		if (!evidence || Date.parse(evidence.capturedAt) > Date.parse(checkpoint.capturedAt)) throw invalidStore();
	}
	return checkpoint;
}

export function formatDurableGoalCheckpoint(goal: DurableGoalSnapshot): string {
	const checkpoint = goal.checkpoint;
	if (!checkpoint) return `Goal: ${goal.objective}\nCheckpoint: none`;
	return [
		`Goal: ${goal.objective}`,
		section("Core", checkpoint.core),
		section("Verified", checkpoint.verifiedEvidenceIds),
		section("Open", checkpoint.open),
		`Next: ${checkpoint.next}`,
	].join("\n");
}

export function parseDurableGoalCheckpointCommand(payload: string, capturedAt: string): DurableGoalCheckpointInput {
	if (typeof payload !== "string" || payload.length === 0 || payload.length > 16_384) {
		throw new DurableGoalError("invalid-input", "checkpoint JSON is invalid");
	}
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		throw new DurableGoalError("invalid-input", "checkpoint JSON is invalid");
	}
	if (
		!isExactRecord(value, ["core", "verified", "open", "next"]) ||
		!isStringArray(value.core) ||
		!isStringArray(value.verified) ||
		!isStringArray(value.open) ||
		typeof value.next !== "string" ||
		!isCanonicalTimestamp(capturedAt)
	) {
		throw new DurableGoalError("invalid-input", "checkpoint JSON is invalid");
	}
	return {
		core: value.core,
		verifiedEvidenceIds: value.verified,
		open: value.open,
		next: value.next,
		capturedAt,
	};
}

function seal(material: Omit<DurableGoalCheckpoint, "digest">): DurableGoalCheckpoint {
	return { ...material, digest: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
}

function textList(value: readonly string[], label: string, code: "invalid-input" | "invalid-store"): readonly string[] {
	if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw goalError(code, `${label} is invalid`);
	const items = value.map((item) => text(item, MAX_ITEM_CHARS, label, code));
	if (new Set(items).size !== items.length) throw goalError(code, `${label} contains duplicates`);
	return items;
}

function evidenceIds(value: readonly string[], code: "invalid-input" | "invalid-store"): readonly string[] {
	const ids = textList(value, "checkpoint verified evidence", code);
	if (ids.some((id) => redactSensitiveTextForced(id) !== id)) {
		throw goalError(code, "checkpoint evidence id contains credential-shaped text");
	}
	return ids;
}

function text(value: string, maxChars: number, label: string, code: "invalid-input" | "invalid-store"): string {
	if (typeof value !== "string") throw goalError(code, `${label} must be text`);
	const redacted = redactSensitiveTextForced(value).trim();
	if (redacted.length === 0 || redacted.length > maxChars) throw goalError(code, `${label} is invalid`);
	return redacted;
}

function timestamp(value: string, label: string): string {
	if (!isCanonicalTimestamp(value)) {
		throw new DurableGoalError("invalid-input", `${label} must be an ISO timestamp`);
	}
	return value;
}

function persistedTextList(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalidStore();
	const items = textList(value, "checkpoint text", "invalid-store");
	if (items.some((item, index) => item !== value[index])) throw invalidStore();
	return items;
}

function persistedEvidenceIds(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalidStore();
	const ids = evidenceIds(value, "invalid-store");
	if (ids.some((id, index) => id !== value[index])) throw invalidStore();
	return ids;
}

function persistedText(value: unknown, maxChars: number): string {
	if (typeof value !== "string") throw invalidStore();
	const parsed = text(value, maxChars, "checkpoint text", "invalid-store");
	if (parsed !== value) throw invalidStore();
	return parsed;
}

function persistedTimestamp(value: unknown): string {
	if (!isCanonicalTimestamp(value)) throw invalidStore();
	return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	const timestamp = Date.parse(value);
	return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function section(label: string, values: readonly string[]): string {
	return values.length === 0 ? `${label}: (none)` : `${label}: ${values.join(" | ")}`;
}

function stringValue(value: unknown): string {
	if (typeof value !== "string") throw invalidStore();
	return value;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function goalError(code: "invalid-input" | "invalid-store", message: string): DurableGoalError {
	return code === "invalid-store" ? invalidStore() : new DurableGoalError(code, message);
}

function invalidStore(): DurableGoalError {
	return new DurableGoalError("invalid-store", "durable goal journal is invalid");
}
