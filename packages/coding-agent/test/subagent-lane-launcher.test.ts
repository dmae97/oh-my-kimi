/**
 * §14.4 acceptance: the orchestration plan drives an actual launcher with
 * the §14.2 width as hard authority — not just a plan-shape test. Children
 * here are fake lane bodies observing real concurrency, permits, and abort.
 */

import { describe, expect, it } from "vitest";
import type { CapabilityInventory, NamedResource } from "../src/core/loadouts.ts";
import type { ResourceAdmissionDecision } from "../src/core/resource-admission.ts";
import {
	computeEffectiveLaneWidth,
	launchSubagentLanes,
	type SubagentLaneContext,
} from "../src/core/subagent-lane-launcher.ts";
import { buildSubagentOrchestrationPlan, type SubagentLaneSpec } from "../src/core/subagent-orchestration.ts";
import { WorkloadPermitPool } from "../src/core/workload-permit-pool.ts";

const resource = (kind: NamedResource["kind"], name: string): NamedResource => ({ kind, name });
const inventory: CapabilityInventory = {
	tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "report_finding"].map((name) =>
		resource("tool", name),
	),
	skills: ["coding-standards", "debugging", "testing-guide"].map((name) => resource("skill", name)),
	mcp: [],
	hooks: [],
};

function decision(maxParallelLanes: number, maxHeavyProcesses = 2): ResourceAdmissionDecision {
	return {
		schemaVersion: 1,
		decisionId: "res-adm-lanes",
		snapshotDigest: "digest",
		pressure: "normal",
		action: "allow",
		maxToolConcurrency: 4,
		maxParallelLanes,
		maxHeavyProcesses,
		reasons: [],
		decidedAt: "2026-08-21T00:00:00.000Z",
	};
}

function explorerLanes(count: number): SubagentLaneSpec[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `explore-${index + 1}`,
		role: "security",
		task: `scan area ${index + 1}`,
	}));
}

function buildPlan(lanes: readonly SubagentLaneSpec[]) {
	const plan = buildSubagentOrchestrationPlan({ runId: "run-1", lanes, inventory, spawnThreshold: 16 });
	expect(plan.batches.length).toBeGreaterThan(0);
	return plan;
}

interface Gauge {
	active: number;
	max: number;
}

function trackingLane(gauge: Gauge, delayMs = 10, failFor?: ReadonlySet<string>) {
	return async (context: SubagentLaneContext): Promise<void> => {
		gauge.active += 1;
		gauge.max = Math.max(gauge.max, gauge.active);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		gauge.active -= 1;
		if (failFor?.has(context.laneId)) {
			throw new Error(`lane ${context.laneId} exploded`);
		}
	};
}

describe("computeEffectiveLaneWidth (§14.2)", () => {
	it("takes the minimum of all five authorities with floor 1", () => {
		expect(
			computeEffectiveLaneWidth({
				planWidth: 4,
				configuredMaxParallelLanes: 3,
				admissionMaxParallelLanes: 2,
				availableHeavyPermits: 5,
				pathConflictFreeWidth: 4,
			}),
		).toBe(2);
		expect(
			computeEffectiveLaneWidth({
				planWidth: 4,
				admissionMaxParallelLanes: 4,
				availableHeavyPermits: 1,
				pathConflictFreeWidth: 4,
			}),
		).toBe(1);
		expect(
			computeEffectiveLaneWidth({
				planWidth: 4,
				configuredMaxParallelLanes: 0, // 0 = unlimited -> other terms win
				admissionMaxParallelLanes: 3,
				availableHeavyPermits: 3,
				pathConflictFreeWidth: 2,
			}),
		).toBe(2);
	});
});

describe("launchSubagentLanes (§14.4 acceptance)", () => {
	it("caps active children at 1 when admission lanes = 1", async () => {
		const gauge: Gauge = { active: 0, max: 0 };
		const result = await launchSubagentLanes({
			plan: buildPlan(explorerLanes(4)),
			promptRunId: "run-1",
			decision: decision(1),
			permitPool: new WorkloadPermitPool({ capacity: 2 }),
			launchLane: trackingLane(gauge),
		});
		expect(result.effectiveLaneWidth).toBe(1);
		expect(result.maxObservedConcurrency).toBe(1);
		expect(gauge.max).toBe(1);
		expect(result.outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(4);
	});

	it("runs exactly 2 conflict-free children when admission lanes = 2", async () => {
		const gauge: Gauge = { active: 0, max: 0 };
		const result = await launchSubagentLanes({
			plan: buildPlan(explorerLanes(4)),
			promptRunId: "run-1",
			decision: decision(2),
			permitPool: new WorkloadPermitPool({ capacity: 2 }),
			launchLane: trackingLane(gauge),
		});
		expect(result.maxObservedConcurrency).toBeLessThanOrEqual(2);
		expect(gauge.max).toBe(2);
	});

	it("shares the parent permit pool for heavy lanes and never leaks on failure (§14.3)", async () => {
		const gauge: Gauge = { active: 0, max: 0 };
		const pool = new WorkloadPermitPool({ capacity: 1 });
		const heavy = new Set(["explore-1", "explore-2"]);
		const result = await launchSubagentLanes({
			plan: buildPlan(explorerLanes(3)),
			promptRunId: "run-1",
			decision: decision(4),
			permitPool: pool,
			heavyLaneIds: heavy,
			launchLane: trackingLane(gauge, 10, new Set(["explore-2"])),
		});
		expect(result.outcomes.find((outcome) => outcome.laneId === "explore-2")?.status).toBe("failed");
		expect(result.outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(2);
		// §23.2 property-8 analogue at lane level: no leaked weight afterwards.
		expect(pool.snapshot()).toMatchObject({ activeWeight: 0, queuedCount: 0 });
	});

	it("propagates parent abort: unstarted lanes never launch and permit waits cancel (§14.3)", async () => {
		const controller = new AbortController();
		const pool = new WorkloadPermitPool({ capacity: 1 });
		const blocker = await pool.acquire({
			requestId: "outer",
			promptRunId: "run-1",
			workloadClass: "heavy",
			weight: 1,
		});
		const launched: string[] = [];
		const resultPromise = launchSubagentLanes({
			plan: buildPlan(explorerLanes(3)),
			promptRunId: "run-1",
			decision: decision(2),
			permitPool: pool,
			heavyLaneIds: new Set(["explore-1", "explore-2", "explore-3"]),
			signal: controller.signal,
			launchLane: async (context) => {
				launched.push(context.laneId);
			},
		});
		setTimeout(() => controller.abort(), 20);
		const result = await resultPromise;
		expect(launched).toHaveLength(0);
		expect(result.outcomes.every((outcome) => outcome.status === "skipped-abort")).toBe(true);
		// Queued lane permit waits were canceled; only the outer blocker holds weight.
		expect(pool.snapshot()).toMatchObject({ activeWeight: 1, queuedCount: 0 });
		blocker.release();
		expect(pool.snapshot()).toMatchObject({ activeWeight: 0, queuedCount: 0 });
	});

	it("hands children the parent decision and an unraisable width (§14.1/§14.4)", async () => {
		const seen: SubagentLaneContext[] = [];
		const parentDecision = decision(2);
		await launchSubagentLanes({
			plan: buildPlan(explorerLanes(3)),
			promptRunId: "run-1",
			decision: parentDecision,
			permitPool: new WorkloadPermitPool({ capacity: 2 }),
			configuredMaxParallelLanes: 8,
			launchLane: async (context) => {
				seen.push(context);
			},
		});
		expect(seen).toHaveLength(3);
		for (const context of seen) {
			expect(context.decision).toBe(parentDecision);
			expect(context.effectiveLaneWidth).toBe(2);
			expect(context.promptRunId).toBe("run-1");
		}
	});

	it("shrinks width when the shared pool is already busy (availableHeavyPermits term)", async () => {
		const pool = new WorkloadPermitPool({ capacity: 2 });
		const held = await pool.acquire({ requestId: "busy", promptRunId: "run-1", workloadClass: "heavy", weight: 1 });
		const gauge: Gauge = { active: 0, max: 0 };
		const result = await launchSubagentLanes({
			plan: buildPlan(explorerLanes(3)),
			promptRunId: "run-1",
			decision: decision(4),
			permitPool: pool,
			launchLane: trackingLane(gauge),
		});
		held.release();
		expect(result.effectiveLaneWidth).toBe(1);
		expect(gauge.max).toBe(1);
	});
});
