import { describe, expect, it } from "vitest";
import {
	compileLoopDefinitionFromPattern,
	detectStarterDrift,
	type LoopPatternRegistryEntry,
	OMK_LOOP_SKELETONS,
	validateLoopPatternRegistry,
} from "../src/core/loop-registry.ts";

const validEntry = (overrides: Partial<LoopPatternRegistryEntry> = {}): LoopPatternRegistryEntry => ({
	id: "daily-triage",
	name: "Daily Triage",
	file: "daily-triage.md",
	goal: "Prioritized morning scan of CI, issues, commits, and chat",
	cadence: "1d-2h",
	risk: "low",
	tools: ["grok", "claude-code", "codex"],
	skills: ["loop-triage", "minimal-fix"],
	state: "STATE.md",
	phases: ["report", "act-small-wins", "escalate"],
	humanGates: ["design-decisions", "multi-file-refactors"],
	starter: "starters/minimal-loop",
	weekOneMode: "L1",
	tokenCost: "low",
	cost: {
		tokensNoop: 5000,
		tokensReport: 50000,
		tokensAction: 200000,
		suggestedDailyCap: 100000,
		earlyExitRequired: false,
	},
	triggerKeywords: ["daily triage", "morning scan", "status sweep"],
	skillTriggers: {
		"loop-triage": ["ci red", "stale pr"],
	},
	connectors: [
		{
			id: "github",
			kind: "connector",
			purpose: "Read issue and pull request state.",
			access: "required",
			tools: ["issues", "pull-requests"],
		},
	],
	...overrides,
});

describe("validateLoopPatternRegistry", () => {
	it("passes a valid registry", () => {
		const result = validateLoopPatternRegistry([validEntry()]);

		expect(result.valid).toBe(true);
		expect(result.diagnostics).toEqual([]);
	});

	it("fails duplicate ids", () => {
		const result = validateLoopPatternRegistry([validEntry(), validEntry({ name: "Duplicate Daily" })]);

		expect(result.valid).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("duplicate-id");
	});

	it("fails starter path traversal", () => {
		for (const starter of ["../evil", "starters/../evil", "/tmp/evil"]) {
			const result = validateLoopPatternRegistry([validEntry({ starter })]);

			expect(result.valid).toBe(false);
			expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid-starter-path");
		}
	});

	it("fails non-monotonic cost", () => {
		const result = validateLoopPatternRegistry([
			validEntry({
				cost: {
					tokensNoop: 5000,
					tokensReport: 4000,
					tokensAction: 200000,
					suggestedDailyCap: 100000,
					earlyExitRequired: false,
				},
			}),
		]);

		expect(result.valid).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("non-monotonic-cost");
	});

	it("fails zero and invalid cadence", () => {
		for (const cadence of ["0m", ""]) {
			const result = validateLoopPatternRegistry([validEntry({ cadence })]);

			expect(result.valid).toBe(false);
			expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid-cadence");
		}
	});

	it("reports trigger overlap diagnostics without failing the registry", () => {
		const result = validateLoopPatternRegistry([
			validEntry({ id: "ci-sweeper", triggerKeywords: ["ci red", "failing checks"] }),
			validEntry({ id: "pr-babysitter", triggerKeywords: ["stale pr", "ci red"] }),
		]);

		expect(result.valid).toBe(true);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("trigger-overlap");
	});

	it("validates built-in OMK loop skeletons", () => {
		const result = validateLoopPatternRegistry(OMK_LOOP_SKELETONS);

		expect(result.valid).toBe(true);
		expect(result.diagnostics).toEqual([]);
		expect(OMK_LOOP_SKELETONS.map((entry) => entry.id)).toEqual([
			"omk-daily-triage",
			"omk-isolated-fix",
			"omk-release-guardian",
		]);
	});

	it("fails invalid native primitive definitions", () => {
		const result = validateLoopPatternRegistry([
			validEntry({
				connectors: [
					{
						id: "",
						kind: "mcp",
						purpose: "",
						access: "required",
						tools: [""],
					},
				],
				worktree: {
					mode: "per-item",
					branchPrefix: "../bad",
					cleanup: "after-run",
					requireCleanCheckout: true,
					maxConcurrentWorktrees: 0,
				},
				subagents: {
					requireMakerChecker: true,
					makerRole: "maker",
					maxParallel: 0,
				},
				durableState: {
					statePath: "../state.json",
					retentionDays: 0,
				},
				humanGatePolicy: {
					gates: [""],
					requiredForRisks: ["high"],
				},
			}),
		]);

		expect(result.valid).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining([
				"connector-id-required",
				"connector-purpose-required",
				"connector-tool-required",
				"worktree-branch-prefix-invalid",
				"worktree-concurrency-invalid",
				"subagent-max-parallel-invalid",
				"subagent-checker-required",
				"invalid-durable-state-path",
				"durable-state-retention-invalid",
				"human-gate-id-required",
			]),
		);
	});
});

describe("detectStarterDrift", () => {
	it("fails when a registry starter is missing from available starters", () => {
		const result = detectStarterDrift(validEntry(), ["ci-sweeper"]);

		expect(result.valid).toBe(false);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "missing-starter",
			}),
		]);
	});
});

describe("compileLoopDefinitionFromPattern", () => {
	it("compiles L1 as report-only safety", () => {
		const definition = compileLoopDefinitionFromPattern(validEntry(), {
			repo: "earendil-works/pi-mono",
			statePath: ".omk/loops/daily-triage/state.json",
			runLogPath: ".omk/loops/daily-triage/run-log.ndjson",
		});

		expect(definition).toMatchObject({
			id: "daily-triage",
			pattern: "daily-triage",
			objective: "Prioritized morning scan of CI, issues, commits, and chat",
			level: "L1",
			watchedScope: { repos: ["earendil-works/pi-mono"] },
			statePath: ".omk/loops/daily-triage/state.json",
			runLogPath: ".omk/loops/daily-triage/run-log.ndjson",
		});
		expect(definition.safety.allowedWriteScopes).toEqual([]);
		expect(definition.safety.requireIndependentVerifier).toBe(false);
		expect(definition.budget.maxSubagentsPerRun).toBe(1);
		expect(definition.schedule).toMatchObject({
			mode: "interval",
			cadence: "1d-2h",
			shortestIntervalMinutes: 120,
			runOn: ["schedule"],
		});
		expect(definition.worktree).toMatchObject({
			mode: "none",
			cleanup: "manual",
			requireCleanCheckout: false,
		});
		expect(definition.skills).toEqual([
			expect.objectContaining({
				id: "loop-triage",
				access: "required",
				triggerKeywords: ["ci red", "stale pr"],
			}),
			expect.objectContaining({
				id: "minimal-fix",
				access: "required",
			}),
		]);
		expect(definition.connectors).toEqual([
			expect.objectContaining({
				id: "github",
				kind: "connector",
				access: "required",
			}),
		]);
		expect(definition.durableState).toMatchObject({
			statePath: ".omk/loops/daily-triage/state.json",
			runLogPath: ".omk/loops/daily-triage/run-log.ndjson",
			budgetLedgerPath: ".omk/loops/daily-triage/budget-ledger.ndjson",
			requireReplayableEvidence: true,
		});
		expect(definition.humanGates).toMatchObject({
			gates: ["design-decisions", "multi-file-refactors"],
			requiredForRisks: ["high"],
			approvalRefsRequired: true,
		});
	});

	it("requires independent verifier for L2 and L3", () => {
		for (const level of ["L2", "L3"] as const) {
			const definition = compileLoopDefinitionFromPattern(validEntry({ weekOneMode: level }), {
				repo: "earendil-works/pi-mono",
				statePath: `.omk/loops/${level}/state.json`,
				runLogPath: `.omk/loops/${level}/run-log.ndjson`,
			});

			expect(definition.safety.requireIndependentVerifier).toBe(true);
			expect(definition.budget.maxSubagentsPerRun).toBeGreaterThan(1);
			expect(definition.worktree?.mode).not.toBe("none");
			expect(definition.subagents).toMatchObject({
				requireMakerChecker: true,
				makerRole: "daily-triage-maker",
				checkerRole: "daily-triage-checker",
			});
		}
	});
});
