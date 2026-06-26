import { describe, expect, it } from "vitest";
import {
	calculateLoopDriftScore,
	evaluateLoopSafetyGates,
	type LoopGateEvidence,
	validateLoopWriteScope,
} from "../src/core/loop-gates.ts";
import type { LoopDefinition, LoopState, LoopWorkItem } from "../src/core/loop-types.ts";

const definition: LoopDefinition = {
	id: "loop-1",
	pattern: "minimal-fix",
	objective: "Fix TypeScript loop gate regressions inside coding agent core files",
	nonGoals: ["rewrite auth", "dependency upgrades", "billing changes"],
	level: "L2",
	watchedScope: {
		repos: ["omk"],
		branches: ["main"],
		paths: ["packages/coding-agent/src/core", "packages/coding-agent/test"],
		tickets: ["LF5"],
	},
	budget: {
		maxRunsPerDay: 5,
		maxTokensPerDay: 100_000,
		maxSubagentsPerRun: 2,
		maxAttemptsPerItem: 3,
	},
	safety: {
		requireIndependentVerifier: true,
		requireHumanGateForHighRisk: true,
		allowedWriteScopes: ["packages/coding-agent/src/core", "packages/coding-agent/test"],
		deniedWriteScopes: ["packages/coding-agent/src/core/loop-budget.ts", "packages/coding-agent/test/fixtures"],
	},
	statePath: ".omk/loops/loop-1/state.json",
	runLogPath: ".omk/loops/loop-1/run-log.jsonl",
	worktree: {
		mode: "per-item",
		branchPrefix: "omk/loops/loop-1/",
		cleanup: "after-run",
		requireCleanCheckout: true,
		maxConcurrentWorktrees: 1,
	},
	durableState: {
		statePath: ".omk/loops/loop-1/state.json",
		runLogPath: ".omk/loops/loop-1/run-log.jsonl",
		budgetLedgerPath: ".omk/loops/loop-1/budget-ledger.ndjson",
		retentionDays: 30,
		requireReplayableEvidence: true,
	},
	humanGates: {
		gates: ["high-risk-change", "scope-expansion"],
		requiredForRisks: ["high"],
		approvalRefsRequired: true,
	},
};

const state: LoopState = {
	loopId: "loop-1",
	status: "active",
	highPriority: [],
	watchList: [],
	humanInbox: [],
	recentNoise: [],
	leases: [],
	budgetUsedToday: { runs: 0, tokensEstimate: 0, subagentSpawns: 0, autoPrs: 0 },
};

const item: LoopWorkItem = {
	id: "LF5",
	source: "manual",
	sourceRef: "LF5",
	title: "Implement TypeScript loop gate validation",
	status: "executing",
	risk: "medium",
	actingOn: "packages/coding-agent/src/core/loop-gates.ts",
	firstSeenAt: "2026-06-25T00:00:00Z",
	lastSeenAt: "2026-06-25T00:00:00Z",
	attemptCount: 0,
	evidenceRefs: ["/tmp/loop-plan/lane-LF5.md"],
};

const passingEvidence: LoopGateEvidence = {
	writeScope: ["packages/coding-agent/src/core/loop-gates.ts", "packages/coding-agent/test/loop-gates.test.ts"],
	changedFiles: ["packages/coding-agent/src/core/loop-gates.ts"],
	evidenceRefs: ["/tmp/loop-plan/lane-LF5.md"],
	verifier: {
		independent: true,
		status: "pass",
		evidenceRefs: ["/tmp/loop-plan/lane-LF5.md#verify"],
	},
	worktree: {
		isolated: true,
		worktreeId: "wt-LF5",
		branch: "omk/loops/loop-1/LF5",
		cleanCheckout: true,
	},
	durableState: {
		stateRevision: "state-rev-1",
		runLogRef: ".omk/loops/loop-1/run-log.jsonl#run-1",
		budgetReservationId: "budget-LF5",
	},
};

describe("validateLoopWriteScope", () => {
	it("blocks denied scope prefixes", () => {
		const result = validateLoopWriteScope(definition, ["packages/coding-agent/src/core/loop-budget.ts"]);

		expect(result.passed).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("write-scope-denied");
	});

	it("blocks empty write scopes for L2/L3 loops", () => {
		const result = validateLoopWriteScope(definition, []);

		expect(result.passed).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("write-scope-empty");
	});
});

describe("evaluateLoopSafetyGates", () => {
	it("allows exact write scope when verifier and evidence are present", () => {
		const result = evaluateLoopSafetyGates(definition, state, item, passingEvidence);

		expect(result).toMatchObject({ passed: true, action: "allow" });
		expect(result.diagnostics).toEqual([]);
	});

	it("blocks isolated loops without worktree evidence", () => {
		const { worktree, ...evidenceWithoutWorktree } = passingEvidence;
		const result = evaluateLoopSafetyGates(definition, state, item, evidenceWithoutWorktree);

		expect(worktree).toBeDefined();
		expect(result.passed).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("worktree-isolation-required");
	});

	it("requires durable state, run log, and budget reservation evidence", () => {
		const result = evaluateLoopSafetyGates(definition, state, item, {
			...passingEvidence,
			durableState: {},
		});

		expect(result.passed).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(["state-revision-missing", "run-log-ref-missing", "budget-reservation-missing"]),
		);
	});

	it("requires a human gate for high-risk items when policy requires it", () => {
		const result = evaluateLoopSafetyGates(definition, state, { ...item, risk: "high" }, passingEvidence);

		expect(result.passed).toBe(false);
		expect(result.action).toBe("human-gate");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("human-gate-required");
	});

	it("blocks L2/L3 actions with missing verifier or evidence refs", () => {
		const result = evaluateLoopSafetyGates(definition, state, item, {
			writeScope: ["packages/coding-agent/src/core"],
			changedFiles: ["packages/coding-agent/src/core/loop-gates.ts"],
		});

		expect(result.passed).toBe(false);
		expect(result.outcome).toBe("verifier-failed");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(["evidence-refs-missing", "independent-verifier-required"]),
		);
	});

	it("escalates and blocks action when max attempts are exhausted", () => {
		const result = evaluateLoopSafetyGates(
			definition,
			state,
			{ ...item, attemptCount: definition.budget.maxAttemptsPerItem },
			passingEvidence,
		);

		expect(result.passed).toBe(false);
		expect(result.action).toBe("escalate");
		expect(result.outcome).toBe("escalated");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("max-attempts-exceeded");
	});
});

describe("calculateLoopDriftScore", () => {
	it("raises drift when the work item overlaps non-goals", () => {
		const aligned = calculateLoopDriftScore(definition, {
			...item,
			title: "Fix TypeScript loop gate regression in coding agent core",
			actingOn: "packages/coding-agent/src/core/loop-gates.ts",
		});
		const drifting = calculateLoopDriftScore(definition, {
			...item,
			title: "Rewrite auth and billing for dependency upgrades",
			actingOn: "auth/session.ts",
		});

		expect(drifting).toBeGreaterThan(aligned);
		expect(drifting).toBeGreaterThanOrEqual(0.7);
		expect(aligned).toBeGreaterThanOrEqual(0);
		expect(aligned).toBeLessThanOrEqual(1);
	});
});
