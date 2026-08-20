import { describe, expect, it } from "vitest";
import {
	applyDurableGoalCommand,
	computeDurableGoalGeneration,
	createDurableGoal,
	DurableGoalError,
	type DurableGoalSnapshot,
	formatDurableGoalCheckpoint,
	parseDurableGoalCheckpointCommand,
	parseDurableGoalSnapshot,
} from "../src/index.ts";

const T0 = "2026-08-19T00:00:00.000Z";
const T1 = "2026-08-19T00:01:00.000Z";
const T2 = "2026-08-19T00:02:00.000Z";
const T3 = "2026-08-19T00:03:00.000Z";
const DIGEST = "a".repeat(64);

function goal() {
	return createDurableGoal({ id: "goal-1", objective: "Ship the verifier", maxRounds: 3, now: T0 });
}

function withEvidence() {
	const created = goal();
	return applyDurableGoalCommand(
		created,
		{ kind: "attach-evidence", ref: created.ref, evidence: { id: "focused-tests", digest: DIGEST, capturedAt: T1 } },
		T1,
	);
}

function checkpoint(current: DurableGoalSnapshot) {
	return applyDurableGoalCommand(
		current,
		{
			kind: "record-checkpoint",
			ref: current.ref,
			checkpoint: {
				core: ["Deterministic gates remain authoritative", `api_key=sk-${"x".repeat(24)}`],
				verifiedEvidenceIds: ["focused-tests"],
				open: ["Calibrate the advisory rubric"],
				next: "Run the package quality gates",
				capturedAt: T1,
			},
		},
		T1,
	);
}

describe("durable goal seam checkpoints", () => {
	it("stores a redacted Goal/Core/Verified/Open/Next checkpoint with a bound digest", () => {
		const recorded = checkpoint(withEvidence());
		const seam = recorded.checkpoint;

		expect(seam).toMatchObject({
			schemaVersion: "omk.goal.checkpoint.v1",
			core: ["Deterministic gates remain authoritative", "api_key=[REDACTED]"],
			verifiedEvidenceIds: ["focused-tests"],
			open: ["Calibrate the advisory rubric"],
			next: "Run the package quality gates",
			capturedAt: T1,
		});
		expect(seam?.goalGeneration).toBe(recorded.evidence[0]?.goalGeneration);
		expect(seam?.digest).toMatch(/^[0-9a-f]{64}$/u);
		expect(formatDurableGoalCheckpoint(recorded)).toContain("Goal: Ship the verifier");
		expect(formatDurableGoalCheckpoint(recorded)).toContain("Verified: focused-tests");
		expect(JSON.stringify(recorded)).not.toContain(`sk-${"x".repeat(24)}`);
	});

	it("keeps the prior seam across a round boundary and clears it when the goal definition changes", () => {
		const recorded = checkpoint(withEvidence());
		const advanced = applyDurableGoalCommand(recorded, { kind: "advance-round", ref: recorded.ref }, T2);
		const edited = applyDurableGoalCommand(
			advanced,
			{ kind: "edit", ref: advanced.ref, objective: "Ship a different verifier" },
			T3,
		);

		expect(advanced.checkpoint).toEqual(recorded.checkpoint);
		expect(advanced.checkpoint?.goalGeneration).not.toBe(computeDurableGoalGeneration(advanced));
		expect(edited.checkpoint).toBeUndefined();
	});

	it("rejects stale evidence references and tampered persisted checkpoints", () => {
		const current = goal();
		expect(() =>
			applyDurableGoalCommand(
				current,
				{
					kind: "record-checkpoint",
					ref: current.ref,
					checkpoint: {
						core: [],
						verifiedEvidenceIds: ["missing"],
						open: [],
						next: "Run tests",
						capturedAt: T1,
					},
				},
				T1,
			),
		).toThrowError(new DurableGoalError("invalid-input", "checkpoint evidence must reference fresh goal evidence"));

		const recorded = checkpoint(withEvidence());
		const tampered = { ...recorded, checkpoint: { ...recorded.checkpoint, next: "Skip tests" } };
		expect(() => parseDurableGoalSnapshot(tampered)).toThrowError(
			new DurableGoalError("invalid-store", "durable goal journal is invalid"),
		);
	});

	it("parses the bounded command payload without accepting timestamps or extra keys", () => {
		expect(
			parseDurableGoalCheckpointCommand(
				JSON.stringify({ core: ["Keep scope fixed"], verified: ["focused-tests"], open: [], next: "Run tests" }),
				T1,
			),
		).toEqual({
			core: ["Keep scope fixed"],
			verifiedEvidenceIds: ["focused-tests"],
			open: [],
			next: "Run tests",
			capturedAt: T1,
		});
		expect(() =>
			parseDurableGoalCheckpointCommand(
				JSON.stringify({ core: [], verified: [], open: [], next: "Run tests", capturedAt: T0 }),
				T1,
			),
		).toThrowError(new DurableGoalError("invalid-input", "checkpoint JSON is invalid"));
		expect(() => parseDurableGoalCheckpointCommand("x".repeat(16_385), T1)).toThrowError(
			new DurableGoalError("invalid-input", "checkpoint JSON is invalid"),
		);
	});

	it("continues to parse legacy snapshots without a checkpoint", () => {
		const legacy = goal();
		expect(parseDurableGoalSnapshot(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
	});
});
