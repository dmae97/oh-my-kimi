import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceAdmissionDecision } from "../src/core/resource-admission.ts";
import { WorkloadPermitPool } from "../src/core/workload-permit-pool.ts";
import {
	executeWorkloadShardPlan,
	type ShardRunContext,
	type ShardRunner,
} from "../src/core/workload-shard-executor.ts";
import { buildShardCommandDescriptor, type WorkloadShardPlan } from "../src/core/workload-shard-plan.ts";
import { WorkloadShardStore, workloadShardJournalPath } from "../src/core/workload-shard-store.ts";

const NOW = () => new Date("2026-08-21T00:00:00.000Z");

function decision(maxHeavyProcesses: number): ResourceAdmissionDecision {
	return {
		schemaVersion: 1,
		decisionId: "adm-exec",
		snapshotDigest: "digest",
		pressure: "normal",
		action: "allow",
		maxToolConcurrency: 4,
		maxParallelLanes: 2,
		maxHeavyProcesses,
		reasons: [],
		decidedAt: NOW().toISOString(),
	};
}

function plan(shardIds: readonly string[], deps: Readonly<Record<string, readonly string[]>> = {}): WorkloadShardPlan {
	return {
		schemaVersion: 1,
		planId: "plan-exec-1",
		promptRunId: "prompt-run-exec",
		commandDigest: "cmd-digest",
		strategy: "vitest-shard",
		createdAt: NOW().toISOString(),
		maxConcurrency: 4,
		shards: shardIds.map((shardId) => ({
			shardId,
			dependencyIds: deps[shardId] ?? [],
			commandDescriptor: buildShardCommandDescriptor(["vitest", `--shard=${shardId}`]),
			expectedEvidence: ["exit-code"],
		})),
	};
}

function newStore(): { store: WorkloadShardStore; cwd: string } {
	const cwd = mkdtempSync(join(tmpdir(), "omk-shard-exec-"));
	return { store: WorkloadShardStore.open(cwd, "prompt-run-exec"), cwd };
}

function passingRunner(log?: Map<string, number>): ShardRunner {
	return async (context: ShardRunContext) => {
		log?.set(context.shard.shardId, (log.get(context.shard.shardId) ?? 0) + 1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { exitCode: 0 };
	};
}

describe("executeWorkloadShardPlan", () => {
	it("runs all shards within the admission-recomputed width and aggregates passed evidence", async () => {
		const { store } = newStore();
		let active = 0;
		let maxActive = 0;
		const runner: ShardRunner = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
			return { exitCode: 0 };
		};
		const evidence = await executeWorkloadShardPlan({
			plan: plan(["a", "b", "c", "d"]),
			store,
			runner,
			decision: decision(2),
			now: NOW,
		});
		expect(evidence.verdict).toBe("passed");
		expect(evidence.kind).toBe("workload_shard_result.v1");
		expect(evidence.counts.passed).toBe(4);
		expect(evidence.effectiveConcurrency).toBe(2);
		expect(maxActive).toBeLessThanOrEqual(2);
		for (const shard of evidence.shards) {
			expect(shard.evidenceRefs).toContain("exit-code:0");
			expect(shard.attempt).toBe(1);
		}
	});

	it("skips passed shards on resume and never reruns them (§13.5 step 3)", async () => {
		const { store, cwd } = newStore();
		const failOnce: ShardRunner = async (context) =>
			context.shard.shardId === "b" ? { exitCode: 1 } : { exitCode: 0 };
		const first = await executeWorkloadShardPlan({
			plan: plan(["a", "b", "c"]),
			store,
			runner: failOnce,
			decision: decision(4),
			now: NOW,
		});
		expect(first.verdict).toBe("failed");
		expect(first.counts).toMatchObject({ passed: 2, failed: 1 });

		const invocations = new Map<string, number>();
		const resumedStore = WorkloadShardStore.open(cwd, "prompt-run-exec");
		const second = await executeWorkloadShardPlan({
			plan: plan(["a", "b", "c"]),
			store: resumedStore,
			runner: passingRunner(invocations),
			decision: decision(4),
			retryFailed: true,
			now: NOW,
		});
		expect(second.verdict).toBe("passed");
		expect(invocations.get("a")).toBeUndefined();
		expect(invocations.get("c")).toBeUndefined();
		expect(invocations.get("b")).toBe(1);
		expect(second.shards.find((shard) => shard.shardId === "b")?.attempt).toBe(2);
	});

	it("does not retry failed shards without the retry policy (§13.5 step 4)", async () => {
		const { store, cwd } = newStore();
		await executeWorkloadShardPlan({
			plan: plan(["a", "b"]),
			store,
			runner: async (context) => ({ exitCode: context.shard.shardId === "b" ? 1 : 0 }),
			decision: decision(2),
			now: NOW,
		});
		const invocations = new Map<string, number>();
		const second = await executeWorkloadShardPlan({
			plan: plan(["a", "b"]),
			store: WorkloadShardStore.open(cwd, "prompt-run-exec"),
			runner: passingRunner(invocations),
			decision: decision(2),
			now: NOW,
		});
		expect(second.verdict).toBe("failed");
		expect(invocations.size).toBe(0);
	});

	it("recovers crash-orphaned running shards through pending re-arm (crash simulation)", async () => {
		const { store, cwd } = newStore();
		const crashPlan = plan(["a", "b"]);
		store.appendPlan(crashPlan);
		store.appendTransition({
			schemaVersion: 1,
			planId: crashPlan.planId,
			shardId: "a",
			attempt: 1,
			state: "running",
			evidenceRefs: [],
		});
		// Process dies here: `a` has no terminal record.

		const invocations = new Map<string, number>();
		const evidence = await executeWorkloadShardPlan({
			plan: crashPlan,
			store: WorkloadShardStore.open(cwd, "prompt-run-exec"),
			runner: passingRunner(invocations),
			decision: decision(2),
			now: NOW,
		});
		expect(evidence.verdict).toBe("passed");
		expect(invocations.get("a")).toBe(1);
		expect(evidence.shards.find((shard) => shard.shardId === "a")?.attempt).toBe(2);
	});

	it("fails closed and quarantines on journal corruption", async () => {
		const { store, cwd } = newStore();
		const target = plan(["a"]);
		store.appendPlan(target);
		const journalFile = workloadShardJournalPath(cwd, "prompt-run-exec");
		writeFileSync(journalFile, `${readFileSync(journalFile, "utf8")}{"tampered":true}\n`);

		let ran = 0;
		const evidence = await executeWorkloadShardPlan({
			plan: target,
			store: WorkloadShardStore.open(cwd, "prompt-run-exec"),
			runner: async () => {
				ran += 1;
				return { exitCode: 0 };
			},
			decision: decision(2),
			now: NOW,
		});
		expect(evidence.verdict).toBe("blocked");
		expect(evidence.reasonCodes[0]).toMatch(/^journal\./);
		expect(ran).toBe(0);
		const entries = readdirSync(join(cwd, ".omk", "runs", "prompt-run-exec"));
		expect(entries.some((entry) => entry.includes(".corrupt-"))).toBe(true);
	});

	it("blocks when the journal belongs to a different plan", async () => {
		const { store, cwd } = newStore();
		store.appendPlan(plan(["a"]));
		const other = { ...plan(["a"]), planId: "plan-other", commandDigest: "other-digest" };
		const evidence = await executeWorkloadShardPlan({
			plan: other,
			store: WorkloadShardStore.open(cwd, "prompt-run-exec"),
			runner: passingRunner(),
			decision: decision(2),
			now: NOW,
		});
		expect(evidence.verdict).toBe("blocked");
		expect(evidence.reasonCodes).toContain("plan.mismatch");
	});

	it("blocks structurally invalid plans without running anything", async () => {
		const { store } = newStore();
		const invalid = { ...plan(["a", "a"]) };
		let ran = 0;
		const evidence = await executeWorkloadShardPlan({
			plan: invalid,
			store,
			runner: async () => {
				ran += 1;
				return { exitCode: 0 };
			},
			decision: decision(2),
			now: NOW,
		});
		expect(evidence.verdict).toBe("blocked");
		expect(evidence.reasonCodes[0]).toBe("plan.invalid");
		expect(ran).toBe(0);
	});

	it("honors dependencies and leaves dependents of failed shards unrun", async () => {
		const { store } = newStore();
		const order: string[] = [];
		const evidence = await executeWorkloadShardPlan({
			plan: plan(["build", "test", "package"], { test: ["build"], package: ["test"] }),
			store,
			runner: async (context) => {
				order.push(context.shard.shardId);
				return { exitCode: context.shard.shardId === "test" ? 1 : 0 };
			},
			decision: decision(4),
			now: NOW,
		});
		expect(order).toEqual(["build", "test"]);
		expect(evidence.verdict).toBe("failed");
		expect(evidence.shards.find((shard) => shard.shardId === "package")?.state).toBe("pending");
	});

	it("propagates abort: no new launches and aborted verdict, permits clean", async () => {
		const { store } = newStore();
		const pool = new WorkloadPermitPool({ capacity: 1 });
		const controller = new AbortController();
		const started: string[] = [];
		const evidence = await executeWorkloadShardPlan({
			plan: plan(["a", "b", "c"]),
			store,
			runner: async (context) => {
				started.push(context.shard.shardId);
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 5));
				return { exitCode: 0 };
			},
			decision: decision(1),
			permitPool: pool,
			signal: controller.signal,
			now: NOW,
		});
		expect(started).toEqual(["a"]);
		expect(evidence.verdict).toBe("aborted");
		expect(evidence.reasonCodes).toContain("run.aborted");
		expect(pool.snapshot()).toMatchObject({ activeWeight: 0, queuedCount: 0 });
	});

	it("property (seed 0x0fc52026): verdict is passed only when every shard passed", async () => {
		const random = mulberry32(0x0fc52026);
		for (let round = 0; round < 25; round++) {
			const shardIds = Array.from({ length: 2 + Math.floor(random() * 4) }, (_, index) => `s${index}`);
			const failing = new Set(shardIds.filter(() => random() < 0.35));
			const { store } = newStore();
			const evidence = await executeWorkloadShardPlan({
				plan: plan(shardIds),
				store,
				runner: async (context) => ({ exitCode: failing.has(context.shard.shardId) ? 1 : 0 }),
				decision: decision(3),
				now: NOW,
			});
			expect(evidence.verdict).toBe(failing.size === 0 ? "passed" : "failed");
			expect(evidence.counts.passed).toBe(shardIds.length - failing.size);
			expect(evidence.shardCount).toBe(shardIds.length);
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
