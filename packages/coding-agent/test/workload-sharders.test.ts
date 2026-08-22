import { describe, expect, it } from "vitest";
import { classifyWorkloadCommand } from "../src/core/workload-classifier.ts";
import { validateWorkloadShardPlan } from "../src/core/workload-shard-plan.ts";
import { planWorkloadShards, type ShardPlanRequest, type WorkloadSharderFacts } from "../src/core/workload-sharders.ts";

function request(command: string, overrides: Partial<ShardPlanRequest> = {}): ShardPlanRequest {
	return {
		promptRunId: "prompt-run-1",
		command,
		classification: classifyWorkloadCommand(command),
		desiredShards: 4,
		planId: "plan-test",
		createdAt: "2026-08-21T00:00:00.000Z",
		...overrides,
	};
}

const VITEST_FACTS: WorkloadSharderFacts = { vitestShardSupport: true };

describe("planWorkloadShards — Vitest/Jest (§12.2)", () => {
	it("appends --shard=i/n while preserving existing options", () => {
		const outcome = planWorkloadShards(request("vitest run --config vitest.config.ts", { facts: VITEST_FACTS }));
		if (outcome.kind !== "planned") throw new Error(`expected plan, got ${JSON.stringify(outcome)}`);
		expect(outcome.plan.strategy).toBe("vitest-shard");
		expect(outcome.plan.shards).toHaveLength(4);
		expect(outcome.plan.maxConcurrency).toBe(4);
		expect(validateWorkloadShardPlan(outcome.plan)).toEqual([]);
		for (const [index, shard] of outcome.plan.shards.entries()) {
			expect(shard.commandDescriptor.redactedArgv).toContain(`--shard=${index + 1}/4`);
			expect(shard.commandDescriptor.redactedArgv).toContain("--config");
			expect(shard.expectedEvidence).toEqual(["exit-code"]);
		}
	});

	it("refuses without verified upstream --shard capability (§12.2 package metadata condition)", () => {
		expect(planWorkloadShards(request("vitest"))).toMatchObject({
			kind: "unsupported",
			reasonCodes: ["shard.capability.unverified"],
		});
		expect(planWorkloadShards(request("vitest", { facts: { vitestShardSupport: false } }))).toMatchObject({
			kind: "unsupported",
			reasonCodes: ["shard.capability.unsupported"],
		});
	});

	it("refuses conflicting flags via the classifier preconditions (§12.1)", () => {
		for (const command of ["vitest --coverage", "vitest --shard=1/2", "jest --runInBand", "jest --watch"]) {
			const outcome = planWorkloadShards(
				request(command, { facts: { vitestShardSupport: true, jestShardSupport: true } }),
			);
			expect(outcome).toMatchObject({ kind: "unsupported", reasonCodes: ["shard.preconditions.failed"] });
		}
	});

	it("plans jest with its own capability fact", () => {
		const outcome = planWorkloadShards(request("jest", { facts: { jestShardSupport: true }, desiredShards: 2 }));
		if (outcome.kind !== "planned") throw new Error("expected plan");
		expect(outcome.plan.strategy).toBe("jest-shard");
		expect(outcome.plan.shards.map((shard) => shard.shardId)).toEqual(["jest-1-of-2", "jest-2-of-2"]);
	});
});

describe("planWorkloadShards — workspaces (§12.2)", () => {
	it("fans npm test out per workspace in deterministic lexical order", () => {
		const outcome = planWorkloadShards(
			request("npm test", { facts: { workspaces: ["zeta", "alpha", "mid"] }, desiredShards: 2 }),
		);
		if (outcome.kind !== "planned") throw new Error("expected plan");
		expect(outcome.plan.strategy).toBe("npm-workspace-test");
		expect(outcome.plan.shards.map((shard) => shard.shardId)).toEqual([
			"workspace-chunk-1-of-2",
			"workspace-chunk-2-of-2",
		]);
		expect(outcome.plan.maxConcurrency).toBe(2); // §13.5: execution reclamps via admission
		expect(outcome.plan.shards[0]?.commandDescriptor.redactedArgv).toEqual([
			"npm",
			"run",
			"test",
			"--workspace=alpha",
			"--workspace=zeta",
		]);
	});

	it("caps workspace plans at 16 shards while covering every workspace once", () => {
		const workspaces = Array.from({ length: 40 }, (_, index) => `workspace-${String(index).padStart(2, "0")}`);
		const outcome = planWorkloadShards(request("npm test", { facts: { workspaces }, desiredShards: 100 }));
		if (outcome.kind !== "planned") throw new Error("expected plan");
		expect(outcome.plan.shards).toHaveLength(16);
		const plannedWorkspaces = outcome.plan.shards.flatMap((shard) =>
			shard.commandDescriptor.redactedArgv
				.filter((token) => token.startsWith("--workspace="))
				.map((token) => token.slice("--workspace=".length)),
		);
		expect(plannedWorkspaces.sort()).toEqual(workspaces);
	});

	it("never fans out builds (dependency order) or already-scoped runs", () => {
		expect(planWorkloadShards(request("npm run build", { facts: { workspaces: ["a", "b"] } }))).toMatchObject({
			kind: "unsupported",
		});
		expect(
			planWorkloadShards(request("npm test --workspace=a", { facts: { workspaces: ["a", "b"] } })),
		).toMatchObject({ kind: "unsupported", reasonCodes: ["shard.workspace.already-scoped"] });
		expect(planWorkloadShards(request("npm test", { facts: { workspaces: ["only-one"] } }))).toMatchObject({
			kind: "unsupported",
			reasonCodes: ["shard.workspace.insufficient"],
		});
	});
});

describe("planWorkloadShards — Go (§12.2)", () => {
	it("chunks the sorted package list and preserves flags like -race", () => {
		const outcome = planWorkloadShards(
			request("go test -race ./...", {
				facts: { goPackages: ["./pkg/z", "./pkg/a", "./pkg/m", "./pkg/b", "./pkg/c"] },
				desiredShards: 2,
			}),
		);
		if (outcome.kind !== "planned") throw new Error("expected plan");
		expect(outcome.plan.strategy).toBe("go-package-chunks");
		expect(outcome.plan.shards).toHaveLength(2);
		const allArgv = outcome.plan.shards.map((shard) => shard.commandDescriptor.redactedArgv);
		for (const argv of allArgv) {
			expect(argv.slice(0, 3)).toEqual(["go", "test", "-race"]);
		}
		// Round-robin over the lexically sorted list, every package exactly once.
		const packages = allArgv.flat().filter((token) => token.startsWith("./") || token === "<redacted>");
		expect(packages).toHaveLength(5);
	});

	it("refuses without a package list or with -run filters", () => {
		expect(planWorkloadShards(request("go test ./..."))).toMatchObject({
			kind: "unsupported",
			reasonCodes: ["shard.go.package-list-unavailable"],
		});
		expect(
			planWorkloadShards(request("go test ./... -run TestX", { facts: { goPackages: ["./a", "./b"] } })),
		).toMatchObject({ kind: "unsupported", reasonCodes: ["shard.preconditions.failed"] });
	});
});

describe("planWorkloadShards — §12.3 forbidden and unknown commands are never rewritten", () => {
	it("refuses complex shell, unknown commands, and deploy-shaped scripts", () => {
		const cases = ["vitest | tee log", "npm run deploy", "cargo test", "./mystery-binary", "rm -rf dist && npm test"];
		for (const command of cases) {
			const outcome = planWorkloadShards(request(command, { facts: { vitestShardSupport: true } }));
			expect(outcome.kind).toBe("unsupported");
		}
	});

	it("refuses insufficient fan-out instead of planning a single shard", () => {
		expect(planWorkloadShards(request("vitest", { facts: VITEST_FACTS, desiredShards: 1 }))).toMatchObject({
			kind: "unsupported",
			reasonCodes: ["shard.fanout.insufficient"],
		});
	});

	it("property (seed 0x0fc52026): planned outcomes always validate and cover exactly n shard indices", () => {
		const random = mulberry32(0x0fc52026);
		const optionPool = ["run", "--config", "vitest.config.ts", "--silent", "--reporter=dot"];
		for (let i = 0; i < 100; i++) {
			const optionCount = Math.floor(random() * optionPool.length);
			const command = ["vitest", ...optionPool.slice(0, optionCount)].join(" ");
			const desiredShards = 2 + Math.floor(random() * 6);
			const outcome = planWorkloadShards(request(command, { facts: VITEST_FACTS, desiredShards }));
			if (outcome.kind !== "planned") throw new Error(`expected plan for ${command}`);
			expect(validateWorkloadShardPlan(outcome.plan)).toEqual([]);
			expect(outcome.plan.shards).toHaveLength(desiredShards);
			const shardFlags = outcome.plan.shards.map(
				(shard) => shard.commandDescriptor.redactedArgv[shard.commandDescriptor.redactedArgv.length - 1],
			);
			expect(new Set(shardFlags).size).toBe(desiredShards);
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
