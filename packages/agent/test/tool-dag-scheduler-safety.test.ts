import { describe, expect, it } from "vitest";
import { scheduleDagLevels } from "../src/tool-dag-scheduler.ts";
import type { ClaimableToolCall, RegisteredToolClaimDefinition } from "../src/tool-resource-claims.ts";

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
	return scheduleDagLevels(toolCalls, { cwd, ...options });
}

describe("scheduleDagLevels invalid claim fail-closed", () => {
	it("isolates a path tool with a missing path argument (exclusive)", async () => {
		expect(
			(
				await schedule([
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "write", arguments: {} },
					{ name: "read", arguments: { path: "b.ts" } },
				])
			).levels,
		).toEqual([[0], [1], [2]]);
	});
});

describe("scheduleDagLevels lexical path safety", () => {
	it("serializes root and descendant claims", async () => {
		expect(
			(
				await schedule([
					{ name: "write", arguments: { path: "/" } },
					{ name: "read", arguments: { path: "/proj/a.ts" } },
				])
			).levels,
		).toEqual([[0], [1]]);
	});

	it("serializes an absolute Windows path with its cwd-relative alias", async () => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "C:\\proj\\a.ts" } },
				{ name: "read", arguments: { path: "a.ts" } },
			],
			{ cwd: "C:\\proj" },
		);
		expect(plan.levels).toEqual([[0], [1]]);
	});

	it("serializes Windows drive-root traversal with its anchored alias", async () => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "C:\\..\\foo" } },
				{ name: "read", arguments: { path: "C:\\foo" } },
			],
			{ cwd: "C:\\proj" },
		);
		expect(plan.levels).toEqual([[0], [1]]);
	});

	it("serializes conflicting UNC aliases", async () => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "\\\\server\\share\\..\\foo" } },
				{ name: "read", arguments: { path: "//server/share/foo" } },
			],
			{ cwd: "C:\\proj" },
		);
		expect(plan.levels).toEqual([[0], [1]]);
	});

	it("serializes a Windows drive root with itself and descendants", async () => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "C:\\" } },
				{ name: "read", arguments: { path: "C:\\" } },
				{ name: "read", arguments: { path: "C:\\foo" } },
			],
			{ cwd: "C:\\proj" },
		);
		expect(plan.levels).toEqual([[0], [1, 2]]);
	});

	it("serializes a Windows root-relative claim with its drive-absolute alias", async () => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "\\foo" } },
				{ name: "read", arguments: { path: "C:\\foo" } },
			],
			{ cwd: "C:\\proj" },
		);
		expect(plan.levels).toEqual([[0], [1]]);
	});
});

describe("scheduleDagLevels concurrency cap", () => {
	it("splits a wide conflict-free level into deterministic contiguous chunks", async () => {
		expect(
			(
				await schedule(
					[
						{ name: "read", arguments: { path: "a.ts" } },
						{ name: "read", arguments: { path: "b.ts" } },
						{ name: "read", arguments: { path: "c.ts" } },
						{ name: "read", arguments: { path: "d.ts" } },
						{ name: "read", arguments: { path: "e.ts" } },
					],
					{ maxConcurrency: 2 },
				)
			).levels,
		).toEqual([[0, 1], [2, 3], [4]]);
	});

	it("applies the cap after head-of-line separation", async () => {
		expect(
			(
				await schedule(
					[
						{ name: "write", arguments: { path: "x" } },
						{ name: "write", arguments: { path: "x" } },
						{ name: "write", arguments: { path: "y" } },
						{ name: "write", arguments: { path: "z" } },
						{ name: "write", arguments: { path: "w" } },
					],
					{ maxConcurrency: 2 },
				)
			).levels,
		).toEqual([[0, 2], [3, 4], [1]]);
	});

	it("ignores absent, zero, NaN, and non-positive caps", async () => {
		const calls = [
			{ name: "read", arguments: { path: "a.ts" } },
			{ name: "read", arguments: { path: "b.ts" } },
			{ name: "read", arguments: { path: "c.ts" } },
		];
		expect((await schedule(calls)).levels).toEqual([[0, 1, 2]]);
		expect((await schedule(calls, { maxConcurrency: 0 })).levels).toEqual([[0, 1, 2]]);
		expect((await schedule(calls, { maxConcurrency: -1 })).levels).toEqual([[0, 1, 2]]);
		expect((await schedule(calls, { maxConcurrency: Number.NaN })).levels).toEqual([[0, 1, 2]]);
	});
});
