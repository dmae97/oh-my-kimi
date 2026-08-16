import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LaneSpawnReceipt } from "../src/core/loadout-runtime.ts";
import type { CapabilityInventory } from "../src/core/loadouts.ts";
import { buildSubagentOrchestrationPlan, type SubagentLaneSpec } from "../src/core/subagent-orchestration.ts";

const EMPTY_INVENTORY: CapabilityInventory = { tools: [], skills: [], mcp: [], hooks: [] };
const SPAWN_PLAN: LaneSpawnReceipt = {
	whyParallel: "generated independent lanes",
	whyNotLocal: "exercise the scheduler",
	independence: "dependencies are encoded in the generated DAG",
	expectedReceiptShape: "laneId and verdict",
	maxInlineTokens: 128,
};

interface GeneratedGraph {
	readonly lanes: readonly SubagentLaneSpec[];
	readonly permutation: readonly SubagentLaneSpec[];
}

const graphArbitrary: fc.Arbitrary<GeneratedGraph> = fc.integer({ min: 1, max: 8 }).chain((nodeCount) =>
	fc.array(fc.boolean(), { minLength: nodeCount * nodeCount, maxLength: nodeCount * nodeCount }).chain((edges) => {
		const lanes = Array.from({ length: nodeCount }, (_, index): SubagentLaneSpec => {
			const id = `L${index}`;
			const dependsOn = Array.from({ length: index }, (_unused, parentIndex) => parentIndex)
				.filter((parentIndex) => edges[index * nodeCount + parentIndex])
				.map((parentIndex) => `L${parentIndex}`);
			return {
				id,
				role: "planner",
				task: `generated lane ${id}`,
				dependsOn,
				readScope: [`generated/${id}`],
			};
		});
		return fc
			.shuffledSubarray(lanes, { minLength: nodeCount, maxLength: nodeCount })
			.map((permutation) => ({ lanes, permutation }));
	}),
);

function routeFor(lanes: readonly SubagentLaneSpec[]) {
	return buildSubagentOrchestrationPlan({
		runId: "property-graph",
		lanes,
		inventory: EMPTY_INVENTORY,
		spawnPlan: SPAWN_PLAN,
		maxParallelLanes: 3,
	}).route;
}

describe("subagent topology properties", () => {
	it("classifies the same DAG identically regardless of lane insertion order", () => {
		fc.assert(
			fc.property(graphArbitrary, ({ lanes, permutation }) => {
				expect(routeFor(permutation)).toEqual(routeFor(lanes));
			}),
			{ numRuns: 250, seed: 0x0fc52026 },
		);
	});
});
