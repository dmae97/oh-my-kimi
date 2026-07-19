import { describe, expect, it } from "vitest";
import { scheduleDagLevels } from "../src/tool-dag-scheduler.ts";
import type { ClaimableToolCall } from "../src/tool-resource-claims.ts";
import { type RegisteredToolClaimDefinition, resolveToolClaims } from "../src/tool-resource-claims.ts";

const cwd = "/proj";

type PolicyMap = Map<string, "sequential" | "parallel">;

function schedule(
	toolCalls: ClaimableToolCall[],
	options: {
		maxConcurrency?: number;
		toolPolicies?: PolicyMap;
		registeredTools?: RegisteredToolClaimDefinition[];
		strictExtensionClaims?: boolean;
	} = {},
) {
	return scheduleDagLevels(toolCalls, {
		cwd,
		toolPolicies: options.toolPolicies,
		registeredTools: options.registeredTools,
		strictExtensionClaims: options.strictExtensionClaims,
		maxConcurrency: options.maxConcurrency,
	});
}

/**
 * O(n) per-file safety check for the generated trace (distinct files only).
 * A level is safe when no path resource is touched by a write together with any
 * other access, and no multi-member level holds an exclusive call. Path
 * aliasing is covered by the small targeted tests above.
 */
function assertLevelsSafe(calls: ClaimableToolCall[], levels: number[][], context?: string): void {
	const resolutions = calls.map((call) => resolveToolClaims(call, { cwd }));
	for (const level of levels) {
		if (level.length > 1) {
			for (const index of level) {
				expect(resolutions[index].kind, context).toBe("claims");
			}
		}
		const byFile = new Map<string, { write: boolean; count: number }>();
		for (const index of level) {
			const resolution = resolutions[index];
			if (resolution.kind !== "claims") {
				continue;
			}
			for (const claim of resolution.claims) {
				if (claim.kind !== "path") {
					continue;
				}
				const entry = byFile.get(claim.key) ?? { write: false, count: 0 };
				if (claim.access === "write") {
					entry.write = true;
				}
				entry.count += 1;
				byFile.set(claim.key, entry);
			}
		}
		for (const entry of byFile.values()) {
			expect(entry.write && entry.count > 1, context).toBe(false);
		}
	}
}

/** Assert the plan covers every source index exactly once. */
function assertCoversAllOnce(levels: number[][], count: number, context?: string): void {
	const seen = levels.flat().sort((a, b) => a - b);
	expect(seen, context).toEqual(Array.from({ length: count }, (_, index) => index));
}

describe("scheduleDagLevels head-of-line example", () => {
	it("schedules write x, write x, write y as [[0,2],[1]]", async () => {
		const calls = [
			{ name: "write", arguments: { path: "x" } },
			{ name: "write", arguments: { path: "x" } },
			{ name: "write", arguments: { path: "y" } },
		];
		const plan = await schedule(calls);
		expect(plan.levels).toEqual([[0, 2], [1]]);
		assertLevelsSafe(calls, plan.levels);
		assertCoversAllOnce(plan.levels, 3);
	});
});

describe("scheduleDagLevels source-directed precedence", () => {
	it("places calls after an earlier exclusive call in a strictly later level", async () => {
		expect(
			(
				await schedule([
					{ name: "read", arguments: { path: "a" } },
					{ name: "bash", arguments: { command: "pwd" } },
					{ name: "read", arguments: { path: "b" } },
				])
			).levels,
		).toEqual([[0], [1], [2]]);
	});

	it("places a read after the latest earlier multi-claim write conflict", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "write_xy",
				resourceClaims: () => [
					{ kind: "path", key: "/proj/x", access: "write" },
					{ kind: "path", key: "/proj/y", access: "write" },
				],
			},
		];
		expect(
			(
				await schedule(
					[
						{ name: "write", arguments: { path: "x" } },
						{ name: "write_xy", arguments: {} },
						{ name: "read", arguments: { path: "y" } },
					],
					{ registeredTools },
				)
			).levels,
		).toEqual([[0], [1], [2]]);
	});
});

describe("scheduleDagLevels conflict matrix", () => {
	it("keeps overlapping read/read parallel in one level", async () => {
		expect(
			(
				await schedule([
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "read", arguments: { path: "a.ts" } },
				])
			).levels,
		).toEqual([[0, 1]]);
	});

	it("splits read/write and write/write on the same path across levels", async () => {
		const calls = [
			{ name: "read", arguments: { path: "a.ts" } },
			{ name: "write", arguments: { path: "a.ts" } },
			{ name: "write", arguments: { path: "a.ts" } },
		];
		const plan = await schedule(calls);
		// read in level 0; both writes conflict with it and each other -> levels 1, 2.
		expect(plan.levels).toEqual([[0], [1], [2]]);
		assertLevelsSafe(calls, plan.levels);
	});

	it("keeps disjoint writes parallel and only serializes overlapping ones", async () => {
		expect(
			(
				await schedule([
					{ name: "write", arguments: { path: "a.ts" } },
					{ name: "write", arguments: { path: "b.ts" } },
					{ name: "write", arguments: { path: "a.ts" } },
				])
			).levels,
		).toEqual([[0, 1], [2]]);
	});
});

describe("scheduleDagLevels default claims", () => {
	it("parallelizes grep/find/read-disjoint and serializes overlapping writes", async () => {
		expect(
			(
				await schedule([
					{ name: "grep", arguments: { pattern: "x" } },
					{ name: "find", arguments: { pattern: "*.ts" } },
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "write", arguments: { path: "a.ts" } },
					{ name: "write", arguments: { path: "a.ts" } },
				])
			).levels,
		).toEqual([[0, 1, 2], [3], [4]]);
	});
});

describe("scheduleDagLevels unknown/bash exclusivity", () => {
	it("gives bash and unknown tools source-directed exclusive levels", async () => {
		expect(
			(
				await schedule([
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "bash", arguments: { command: "ls" } },
					{ name: "custom_tool", arguments: {} },
					{ name: "read", arguments: { path: "b.ts" } },
				])
			).levels,
		).toEqual([[0], [1], [2], [3]]);
	});
});

describe("scheduleDagLevels strict extension mode", () => {
	it("treats parallel extension tools as freely parallel by default", async () => {
		const toolPolicies: PolicyMap = new Map([["ext", "parallel"]]);
		expect(
			(
				await schedule(
					[
						{ name: "ext", arguments: { v: 1 } },
						{ name: "ext", arguments: { v: 2 } },
						{ name: "read", arguments: { path: "a.ts" } },
					],
					{ toolPolicies },
				)
			).levels,
		).toEqual([[0, 1, 2]]);
	});

	it("makes parallel extension tools exclusive under strictExtensionClaims", async () => {
		const toolPolicies: PolicyMap = new Map([["ext", "parallel"]]);
		expect(
			(
				await schedule(
					[
						{ name: "ext", arguments: { v: 1 } },
						{ name: "read", arguments: { path: "a.ts" } },
					],
					{ toolPolicies, strictExtensionClaims: true },
				)
			).levels,
		).toEqual([[0], [1]]);
	});
});
