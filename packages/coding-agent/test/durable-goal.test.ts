import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeDurableGoalGeneration,
	createDurableGoal,
	DurableGoalError,
	freshDurableGoalEvidence,
} from "../src/core/durable-goal.ts";
import { applyDurableGoalCommand } from "../src/core/durable-goal-reducer.ts";
import { DurableGoalStore } from "../src/core/durable-goal-store.ts";

const T0 = "2026-08-18T00:00:00.000Z";
const T1 = "2026-08-18T00:01:00.000Z";
const T2 = "2026-08-18T00:02:00.000Z";
const DIGEST = "a".repeat(64);

function goal() {
	return createDurableGoal({ id: "goal-1", objective: "Ship durable goals", maxRounds: 3, now: T0 });
}

describe("durable goal lifecycle", () => {
	it("uses revision references as compare-and-set guards", () => {
		const created = goal();
		expect(() =>
			applyDurableGoalCommand(created, { kind: "pause", ref: created.ref }, "2000-01-01T00:00:00.000Z"),
		).toThrowError(new DurableGoalError("invalid-input", "goal timestamps must be monotonic"));
		const paused = applyDurableGoalCommand(created, { kind: "pause", ref: created.ref }, T1);
		expect(created.generationStartedAt).toBe(T0);
		expect(paused.status).toBe("paused");
		expect(paused.ref.revision).toBe(2);
		expect(paused.generationStartedAt).toBe(T0);

		expect(() => applyDurableGoalCommand(paused, { kind: "resume", ref: created.ref }, T2)).toThrowError(
			new DurableGoalError("stale-ref", "goal reference is stale"),
		);
		const resumed = applyDurableGoalCommand(paused, { kind: "resume", ref: paused.ref }, T2);
		expect(resumed.status).toBe("active");
	});

	it("requires evidence captured for the current semantic generation", () => {
		const created = goal();
		expect(() =>
			applyDurableGoalCommand(
				created,
				{
					kind: "attach-evidence",
					ref: created.ref,
					evidence: { id: "stale-tests", digest: DIGEST, capturedAt: "2000-01-01T00:00:00.000Z" },
				},
				T1,
			),
		).toThrowError(new DurableGoalError("invalid-input", "evidence timestamp is outside current goal generation"));
		const evidenced = applyDurableGoalCommand(
			created,
			{ kind: "attach-evidence", ref: created.ref, evidence: { id: "tests", digest: DIGEST, capturedAt: T1 } },
			T1,
		);
		expect(evidenced.evidence[0]?.goalGeneration).toBe(computeDurableGoalGeneration(evidenced));

		const edited = applyDurableGoalCommand(
			evidenced,
			{ kind: "edit", ref: evidenced.ref, objective: "Ship better durable goals" },
			T2,
		);
		expect(() => applyDurableGoalCommand(edited, { kind: "complete", ref: edited.ref }, T2)).toThrowError(
			new DurableGoalError("evidence-required", "fresh goal evidence is required"),
		);
		const refreshed = applyDurableGoalCommand(
			edited,
			{ kind: "attach-evidence", ref: edited.ref, evidence: { id: "tests-2", digest: DIGEST, capturedAt: T2 } },
			T2,
		);
		expect(applyDurableGoalCommand(refreshed, { kind: "complete", ref: refreshed.ref }, T2).status).toBe("completed");
	});

	it("does not revive evidence when a goal returns to an earlier definition", () => {
		const created = goal();
		const evidenced = applyDurableGoalCommand(
			created,
			{
				kind: "attach-evidence",
				ref: created.ref,
				evidence: { id: "initial-tests", digest: DIGEST, capturedAt: T0 },
			},
			T0,
		);
		const changed = applyDurableGoalCommand(
			evidenced,
			{ kind: "edit", ref: evidenced.ref, objective: "Ship a different goal" },
			T1,
		);
		const restored = applyDurableGoalCommand(
			changed,
			{ kind: "edit", ref: changed.ref, objective: created.objective },
			T2,
		);

		expect(computeDurableGoalGeneration(restored)).not.toBe(computeDurableGoalGeneration(created));
		expect(freshDurableGoalEvidence(restored)).toEqual([]);
		expect(() => applyDurableGoalCommand(restored, { kind: "complete", ref: restored.ref }, T2)).toThrowError(
			new DurableGoalError("evidence-required", "fresh goal evidence is required"),
		);
		expect(() =>
			applyDurableGoalCommand(changed, { kind: "edit", ref: changed.ref, objective: created.objective }, T1),
		).toThrowError(new DurableGoalError("invalid-input", "goal generation timestamp must advance"));
	});

	it("enforces the configured round ceiling", () => {
		const created = createDurableGoal({ id: "goal-1", objective: "One round", maxRounds: 1, now: T0 });
		const advanced = applyDurableGoalCommand(created, { kind: "advance-round", ref: created.ref }, T1);
		expect(advanced.completedRounds).toBe(1);
		expect(() => applyDurableGoalCommand(advanced, { kind: "advance-round", ref: advanced.ref }, T2)).toThrowError(
			new DurableGoalError("round-limit", "goal round limit reached"),
		);
	});
});

describe("DurableGoalStore", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function storePath(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "omk-goal-"));
		roots.push(root);
		return join(root, "goal.json");
	}

	it("persists append-only revisions and rejects stale writers", async () => {
		const filePath = await storePath();
		const first = new DurableGoalStore(filePath);
		const second = new DurableGoalStore(filePath);
		expect("append" in first).toBe(false);
		const created = await first.create(goal());
		const staleRef = (await second.current())?.ref;
		expect(staleRef).toEqual(created.ref);

		const paused = await first.transition({ kind: "pause", ref: created.ref }, T1);
		await expect(second.transition({ kind: "resume", ref: created.ref }, T2)).rejects.toThrowError(
			new DurableGoalError("stale-ref", "goal reference is stale"),
		);
		expect((await first.readJournal())?.revisions.map((revision) => revision.ref.revision)).toEqual([1, 2]);
		expect((await new DurableGoalStore(filePath).current())?.ref).toEqual(paused.ref);
	});

	it("rejects an initial snapshot that bypasses lifecycle completion", async () => {
		const filePath = await storePath();
		const invalid = { ...goal(), status: "completed" as const, terminalAt: T1 };
		await expect(new DurableGoalStore(filePath).create(invalid)).rejects.toThrowError(
			new DurableGoalError("invalid-store", "durable goal journal is invalid"),
		);
	});

	it("fails closed on malformed persisted state", async () => {
		const filePath = await storePath();
		await writeFile(filePath, '{"schemaVersion":"wrong","revisions":[]}\n');
		await expect(new DurableGoalStore(filePath).current()).rejects.toThrowError(
			new DurableGoalError("invalid-store", "durable goal journal is invalid"),
		);
	});
});
