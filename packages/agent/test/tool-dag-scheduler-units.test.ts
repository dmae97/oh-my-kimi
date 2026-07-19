import { describe, expect, it } from "vitest";
import { applyConcurrencyCap, assignDagLevels, scheduleDagLevels } from "../src/tool-dag-scheduler.ts";

const cwd = "/proj";

describe("applyConcurrencyCap and assignDagLevels unit invariants", () => {
	it("applyConcurrencyCap returns copies and is a no-op without a cap", () => {
		const input = [[0, 1, 2]];
		const out = applyConcurrencyCap(input, undefined);
		expect(out).toEqual([[0, 1, 2]]);
		expect(out).not.toBe(input);
	});

	it("assignDagLevels is purely claim-driven and never co-locates conflicts", () => {
		const entries = [
			{
				sourceIndex: 0,
				resolution: {
					kind: "claims" as const,
					claims: [{ access: "write" as const, kind: "path" as const, key: "/proj/x" }],
				},
				canonicalClaims: [{ access: "write" as const, kind: "path" as const, key: "/proj/x" }],
			},
			{
				sourceIndex: 1,
				resolution: {
					kind: "claims" as const,
					claims: [{ access: "write" as const, kind: "path" as const, key: "/proj/x" }],
				},
				canonicalClaims: [{ access: "write" as const, kind: "path" as const, key: "/proj/x" }],
			},
			{
				sourceIndex: 2,
				resolution: {
					kind: "claims" as const,
					claims: [{ access: "write" as const, kind: "path" as const, key: "/proj/y" }],
				},
				canonicalClaims: [{ access: "write" as const, kind: "path" as const, key: "/proj/y" }],
			},
		];
		expect(assignDagLevels(entries)).toEqual([[0, 2], [1]]);
	});
});

describe("resource-key resolver injection (ALG002-A)", () => {
	/** Fake identity resolver: everything under /proj/current is an alias of /proj/releases/42. */
	const aliasResolver = {
		resolvePath: async (rawPath: string) => ({
			lexicalKey: rawPath,
			realKey: rawPath.replace("/proj/current/", "/proj/releases/42/"),
		}),
	};

	it("serializes symlink-aliased writes that are lexically disjoint", async () => {
		const plan = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "/proj/current/a.ts", content: "" } },
				{ name: "write", arguments: { path: "/proj/releases/42/a.ts", content: "" } },
				{ name: "write", arguments: { path: "/proj/other/b.ts", content: "" } },
			],
			{ cwd, resourceKeyResolver: aliasResolver },
		);
		// Aliased writes conflict; the independent write still joins level 0.
		expect(plan.levels).toEqual([[0, 2], [1]]);
	});

	it("keeps aliased reads parallel and remains deterministic without a resolver", async () => {
		const withResolver = await scheduleDagLevels(
			[
				{ name: "read", arguments: { path: "/proj/current/a.ts" } },
				{ name: "read", arguments: { path: "/proj/releases/42/a.ts" } },
			],
			{ cwd, resourceKeyResolver: aliasResolver },
		);
		expect(withResolver.levels).toEqual([[0, 1]]);

		const withoutResolver = await scheduleDagLevels(
			[
				{ name: "write", arguments: { path: "/proj/current/a.ts", content: "" } },
				{ name: "write", arguments: { path: "/proj/releases/42/a.ts", content: "" } },
			],
			{ cwd },
		);
		// Without identity resolution the lexically disjoint writes stay parallel (v1-compatible).
		expect(withoutResolver.levels).toEqual([[0, 1]]);
	});
});
