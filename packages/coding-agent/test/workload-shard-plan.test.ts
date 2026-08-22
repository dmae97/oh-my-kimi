import { describe, expect, it } from "vitest";
import {
	buildShardCommandDescriptor,
	canTransitionShardState,
	planShardResume,
	reduceShardRecords,
	validateWorkloadShardPlan,
	WORKLOAD_SHARD_PLAN_VERSION,
	type WorkloadShardPlan,
	type WorkloadShardRecord,
	type WorkloadShardState,
} from "../src/core/workload-shard-plan.ts";

function plan(shards: ReadonlyArray<{ id: string; deps?: readonly string[] }>): WorkloadShardPlan {
	return {
		schemaVersion: WORKLOAD_SHARD_PLAN_VERSION,
		planId: "plan-1",
		promptRunId: "prompt-run-1",
		commandDigest: "digest",
		strategy: "vitest-shard",
		createdAt: "2026-08-21T00:00:00.000Z",
		maxConcurrency: 2,
		shards: shards.map((shard) => ({
			shardId: shard.id,
			dependencyIds: shard.deps ?? [],
			commandDescriptor: buildShardCommandDescriptor(["vitest", "--shard=1/2"]),
			expectedEvidence: ["exit-code"],
		})),
	};
}

function record(
	shardId: string,
	state: WorkloadShardState,
	attempt: number,
	overrides: Partial<WorkloadShardRecord> = {},
): WorkloadShardRecord {
	return { schemaVersion: 1, planId: "plan-1", shardId, attempt, state, evidenceRefs: [], ...overrides };
}

describe("buildShardCommandDescriptor (§22.1)", () => {
	it("keeps executable basename and flags, redacts paths, and digests the raw argv", () => {
		const descriptor = buildShardCommandDescriptor([
			"/usr/bin/vitest",
			"run",
			"--shard=1/4",
			"/home/user/secret/dir",
		]);
		expect(descriptor.executable).toBe("vitest");
		expect(descriptor.redactedArgv).toEqual(["vitest", "run", "--shard=1/4", "<redacted>"]);
		expect(descriptor.argvDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(descriptor)).not.toContain("/home/user");
	});
});

describe("validateWorkloadShardPlan", () => {
	it("accepts a valid DAG and rejects structural corruption", () => {
		expect(validateWorkloadShardPlan(plan([{ id: "a" }, { id: "b", deps: ["a"] }]))).toEqual([]);
		expect(validateWorkloadShardPlan(plan([{ id: "a" }, { id: "a" }])).join()).toContain("duplicate");
		expect(validateWorkloadShardPlan(plan([{ id: "a", deps: ["ghost"] }])).join()).toContain("unknown");
		expect(
			validateWorkloadShardPlan(
				plan([
					{ id: "a", deps: ["b"] },
					{ id: "b", deps: ["a"] },
				]),
			).join(),
		).toContain("cycle");
		expect(validateWorkloadShardPlan(plan([])).join()).toContain("empty");
	});
});

describe("shard state machine (§13.4)", () => {
	it("allows exactly the documented transitions", () => {
		expect(canTransitionShardState("pending", "running")).toBe(true);
		for (const terminal of ["passed", "failed", "aborted", "interrupted"] as const) {
			expect(canTransitionShardState("running", terminal)).toBe(true);
		}
		for (const rearmable of ["failed", "aborted", "interrupted"] as const) {
			expect(canTransitionShardState(rearmable, "pending")).toBe(true);
		}
		expect(canTransitionShardState("passed", "pending")).toBe(false);
		expect(canTransitionShardState("pending", "passed")).toBe(false);
		expect(canTransitionShardState("running", "running")).toBe(false);
	});
});

describe("reduceShardRecords (§13.5, fail closed §21)", () => {
	it("replays a retry lifecycle with monotonic attempts", () => {
		const projections = reduceShardRecords(plan([{ id: "a" }]), [
			record("a", "running", 1),
			record("a", "failed", 1, { reasonCode: "exit-1" }),
			record("a", "pending", 1),
			record("a", "running", 2),
			record("a", "passed", 2, { evidenceRefs: ["receipt-1"] }),
		]);
		expect(projections.get("a")).toMatchObject({ state: "passed", attempt: 2, evidenceRefs: ["receipt-1"] });
	});

	it("throws on unknown shards, foreign plans, illegal transitions, and attempt drift", () => {
		const p = plan([{ id: "a" }]);
		expect(() => reduceShardRecords(p, [record("ghost", "running", 1)])).toThrow(/not in plan/);
		expect(() => reduceShardRecords(p, [record("a", "running", 1, { planId: "other" })])).toThrow(/planId/);
		expect(() => reduceShardRecords(p, [record("a", "passed", 1)])).toThrow(/illegal transition/);
		expect(() => reduceShardRecords(p, [record("a", "running", 2)])).toThrow(/attempt/);
		expect(() =>
			reduceShardRecords(p, [record("a", "running", 1), record("a", "passed", 1), record("a", "pending", 1)]),
		).toThrow(/illegal transition/);
	});
});

describe("planShardResume (§13.5, scenario F §23.3)", () => {
	it("skips passed work, projects crashed running shards as interrupted, and honors dependencies", () => {
		const p = plan([{ id: "s1" }, { id: "s2" }, { id: "s3", deps: ["s1"] }, { id: "s4", deps: ["s2"] }]);
		const projections = reduceShardRecords(p, [
			record("s1", "running", 1),
			record("s1", "passed", 1),
			record("s2", "running", 1), // crash: no terminal record
		]);
		const resume = planShardResume(p, projections);
		expect(resume).toEqual({
			skip: ["s1"],
			ready: ["s3"],
			blocked: ["s4"],
			retryable: [],
			resumable: [],
			interrupted: ["s2"],
		});
	});

	it("routes failed and aborted shards to their §13.4 re-arm buckets", () => {
		const p = plan([{ id: "a" }, { id: "b" }]);
		const projections = reduceShardRecords(p, [
			record("a", "running", 1),
			record("a", "failed", 1),
			record("b", "running", 1),
			record("b", "aborted", 1),
		]);
		const resume = planShardResume(p, projections);
		expect(resume.retryable).toEqual(["a"]);
		expect(resume.resumable).toEqual(["b"]);
	});
});

describe("shard properties (§23.2, seed 0x0fc52026)", () => {
	const SCRIPTS: ReadonlyArray<readonly WorkloadShardState[]> = [
		[],
		["running"],
		["running", "passed"],
		["running", "failed"],
		["running", "failed", "pending"],
		["running", "aborted"],
		["running", "interrupted"],
		["running", "failed", "pending", "running", "passed"],
		["running", "interrupted", "pending", "running", "failed"],
	];

	function randomHistory(random: () => number, shardIds: readonly string[]): WorkloadShardRecord[] {
		const records: WorkloadShardRecord[] = [];
		for (const shardId of shardIds) {
			const script = SCRIPTS[Math.floor(random() * SCRIPTS.length)];
			let attempt = 0;
			for (const state of script) {
				if (state === "running") attempt += 1;
				records.push(record(shardId, state, attempt));
			}
		}
		return records;
	}

	it("property 9: a passed shard is only ever skipped on resume", () => {
		const random = mulberry32(0x0fc52026);
		for (let i = 0; i < 200; i++) {
			const shardIds = ["a", "b", "c", "d"].slice(0, 2 + Math.floor(random() * 3));
			const p = plan(shardIds.map((id) => ({ id })));
			const projections = reduceShardRecords(p, randomHistory(random, shardIds));
			const resume = planShardResume(p, projections);
			for (const shardId of shardIds) {
				if (projections.get(shardId)?.state === "passed") {
					expect(resume.skip).toContain(shardId);
					for (const bucket of [resume.ready, resume.retryable, resume.resumable, resume.interrupted]) {
						expect(bucket).not.toContain(shardId);
					}
				}
			}
		}
	});

	it("property 10: journal replay is deterministic", () => {
		const random = mulberry32(0x0fc52026 ^ 0xabc);
		for (let i = 0; i < 100; i++) {
			const shardIds = ["a", "b", "c"];
			const p = plan(shardIds.map((id) => ({ id })));
			const records = randomHistory(random, shardIds);
			const first = reduceShardRecords(p, records);
			const second = reduceShardRecords(p, records);
			expect([...second.entries()]).toEqual([...first.entries()]);
		}
	});
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
