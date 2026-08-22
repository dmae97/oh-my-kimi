import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildShardCommandDescriptor,
	planShardResume,
	WORKLOAD_SHARD_PLAN_VERSION,
	type WorkloadShardPlan,
	type WorkloadShardRecord,
	type WorkloadShardState,
} from "../src/core/workload-shard-plan.ts";
import {
	WorkloadShardJournalError,
	WorkloadShardStore,
	workloadShardJournalPath,
} from "../src/core/workload-shard-store.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-shard-store-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function plan(shardIds: readonly string[]): WorkloadShardPlan {
	return {
		schemaVersion: WORKLOAD_SHARD_PLAN_VERSION,
		planId: "plan-1",
		promptRunId: "prompt-run-1",
		commandDigest: "digest",
		strategy: "vitest-shard",
		createdAt: "2026-08-21T00:00:00.000Z",
		maxConcurrency: 2,
		shards: shardIds.map((shardId) => ({
			shardId,
			dependencyIds: [],
			commandDescriptor: buildShardCommandDescriptor(["vitest", `--shard=${shardId}`]),
			expectedEvidence: ["exit-code"],
		})),
	};
}

function record(shardId: string, state: WorkloadShardState, attempt: number): WorkloadShardRecord {
	return { schemaVersion: 1, planId: "plan-1", shardId, attempt, state, evidenceRefs: [] };
}

describe("WorkloadShardStore", () => {
	it("writes the §13.3 path and round-trips plan, records, and projections", () => {
		const store = WorkloadShardStore.open(tempDir, "prompt-run-1");
		expect(store.filePath).toBe(path.join(tempDir, ".omk", "runs", "prompt-run-1", "workload-shards.jsonl"));
		store.appendPlan(plan(["s1", "s2"]));
		store.appendTransition(record("s1", "running", 1));
		store.appendTransition(record("s1", "passed", 1));

		const reopened = WorkloadShardStore.open(tempDir, "prompt-run-1").load();
		expect(reopened.plan?.planId).toBe("plan-1");
		expect(reopened.records).toHaveLength(2);
		expect(reopened.projections?.get("s1")?.state).toBe("passed");
		expect(reopened.projections?.get("s2")?.state).toBe("pending");
	});

	it("continues the hash chain across reopen", () => {
		const first = WorkloadShardStore.open(tempDir, "prompt-run-1");
		first.appendPlan(plan(["s1"]));
		first.appendTransition(record("s1", "running", 1));

		const second = WorkloadShardStore.open(tempDir, "prompt-run-1");
		second.appendTransition(record("s1", "passed", 1));
		expect(WorkloadShardStore.open(tempDir, "prompt-run-1").load().projections?.get("s1")?.state).toBe("passed");
	});

	it("fails closed on plan misuse and illegal transitions without writing", () => {
		const store = WorkloadShardStore.open(tempDir, "prompt-run-1");
		expect(() => store.appendTransition(record("s1", "running", 1))).toThrow(WorkloadShardJournalError);
		store.appendPlan(plan(["s1"]));
		expect(() => store.appendPlan(plan(["s1"]))).toThrow(/already contains a plan/);
		expect(() => store.appendTransition(record("s1", "passed", 1))).toThrow(/illegal transition/);
		expect(() => store.appendTransition(record("ghost", "running", 1))).toThrow(WorkloadShardJournalError);
		// The rejected appends never reached the file.
		expect(WorkloadShardStore.open(tempDir, "prompt-run-1").load().records).toHaveLength(0);
	});

	it("rejects an invalid plan at append time", () => {
		const store = WorkloadShardStore.open(tempDir, "prompt-run-1");
		expect(() => store.appendPlan(plan([]))).toThrow(/invalid plan/);
	});

	it("detects tampering and truncated tails, and quarantines fail-closed journals (§21)", () => {
		const store = WorkloadShardStore.open(tempDir, "prompt-run-1");
		store.appendPlan(plan(["s1"]));
		store.appendTransition(record("s1", "running", 1));

		const raw = fs.readFileSync(store.filePath, "utf8");
		fs.writeFileSync(store.filePath, raw.replace('"running"', '"passed\u0000"').replace("passed\u0000", "passed"));
		const tampered = WorkloadShardStore.open(tempDir, "prompt-run-1");
		expect(() => tampered.load()).toThrow(WorkloadShardJournalError);

		const quarantinePath = tampered.quarantine();
		expect(quarantinePath).toContain(".corrupt-");
		expect(fs.existsSync(store.filePath)).toBe(false);
		// After quarantine the journal reads as empty instead of resuming over corruption.
		expect(WorkloadShardStore.open(tempDir, "prompt-run-1").load().plan).toBeNull();

		// Truncated tail: partial JSON line fails parse, never resumes silently.
		fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
		fs.writeFileSync(store.filePath, '{"seq":0,"digest":"x","kind":"pl');
		expect(() => WorkloadShardStore.open(tempDir, "prompt-run-1").load()).toThrow(/not valid JSON/);
	});

	it("detects sequence gaps", () => {
		const store = WorkloadShardStore.open(tempDir, "prompt-run-1");
		store.appendPlan(plan(["s1"]));
		store.appendTransition(record("s1", "running", 1));
		const lines = fs.readFileSync(store.filePath, "utf8").trim().split("\n");
		fs.writeFileSync(store.filePath, `${lines[0]}\n`); // drop the tail
		const reopened = WorkloadShardStore.open(tempDir, "prompt-run-1");
		expect(reopened.load().records).toHaveLength(0); // clean prefix is fine
		fs.writeFileSync(store.filePath, `${lines[1]}\n`); // orphan tail: wrong seq + chain
		expect(() => WorkloadShardStore.open(tempDir, "prompt-run-1").load()).toThrow(WorkloadShardJournalError);
	});

	it("rejects path-traversal promptRunIds", () => {
		expect(() => workloadShardJournalPath(tempDir, "../escape")).toThrow(WorkloadShardJournalError);
	});

	it("scenario F (§23.3): crash and resume skips passed work and re-arms the interrupted shard", () => {
		const before = WorkloadShardStore.open(tempDir, "prompt-run-1");
		before.appendPlan(plan(["s1", "s2"]));
		before.appendTransition(record("s1", "running", 1));
		before.appendTransition(record("s1", "passed", 1));
		before.appendTransition(record("s2", "running", 1));
		// process crash: nothing else written

		const after = WorkloadShardStore.open(tempDir, "prompt-run-1");
		const loaded = after.load();
		if (loaded.plan === null || loaded.projections === null) throw new Error("journal lost");
		const resume = planShardResume(loaded.plan, loaded.projections);
		expect(resume.skip).toEqual(["s1"]);
		expect(resume.interrupted).toEqual(["s2"]);

		// §13.5 recovery choreography: interrupted -> pending -> new attempt.
		after.appendTransition(record("s2", "interrupted", 1));
		after.appendTransition(record("s2", "pending", 1));
		after.appendTransition(record("s2", "running", 2));
		after.appendTransition(record("s2", "passed", 2));
		const finalState = WorkloadShardStore.open(tempDir, "prompt-run-1").load();
		expect(finalState.projections?.get("s2")).toMatchObject({ state: "passed", attempt: 2 });
		// §13.6: the projection is evidence input, not a task verdict — nothing
		// here marks the task itself passed.
	});
});
