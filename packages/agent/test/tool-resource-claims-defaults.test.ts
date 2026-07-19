import { describe, expect, it } from "vitest";
import {
	canonicalizeClaims,
	claimsConflict,
	resolveToolClaims,
	resolveToolClaimsForCall,
	type ToolClaimResolution,
	type ToolResourceClaim,
} from "../src/tool-resource-claims.ts";

const cwd = "/proj";

function claim(access: "read" | "write", key: string, kind: ToolResourceClaim["kind"] = "path"): ToolResourceClaim {
	if (kind === "path") return { access, kind, key };
	return { access, kind, key };
}

function claims(...claims: ToolResourceClaim[]): ToolClaimResolution {
	return { kind: "claims", claims };
}

function exclusive(): ToolClaimResolution {
	return { kind: "exclusive" };
}

describe("resolveToolClaims defaults", () => {
	it("claims read access for read tools", () => {
		expect(resolveToolClaims({ name: "read", arguments: { path: "a.ts" } }, { cwd })).toEqual(
			claims(claim("read", "/proj/a.ts")),
		);
	});

	it("claims write access for write tools", () => {
		expect(resolveToolClaims({ name: "write", arguments: { path: "a.ts" } }, { cwd })).toEqual(
			claims(claim("write", "/proj/a.ts")),
		);
	});

	it("claims write access for edit tools", () => {
		expect(resolveToolClaims({ name: "edit", arguments: { path: "a.ts" } }, { cwd })).toEqual(
			claims(claim("write", "/proj/a.ts")),
		);
	});

	it("claims workspace-root read access for unscoped search tools", () => {
		for (const name of ["grep", "find", "ls", "search_files"]) {
			expect(resolveToolClaims({ name, arguments: {} }, { cwd })).toEqual(claims(claim("read", cwd)));
		}
	});

	it("treats clarify-style and bash tools as exclusive", () => {
		expect(resolveToolCallsExclusive("clarify", { question: "?" }));
		expect(resolveToolCallsExclusive("bash", { command: "ls" }));
	});

	it("fails closed to exclusive for unknown tools without an explicit parallel grant", () => {
		expect(resolveToolCallsExclusive("custom_tool", {}));
	});

	it("makes extension tools with executionMode parallel freely parallel by default", () => {
		const toolPolicies: Map<string, "sequential" | "parallel"> = new Map([["custom", "parallel"]]);
		expect(resolveToolClaims({ name: "custom", arguments: { value: 1 } }, { cwd, toolPolicies })).toEqual(claims());
	});

	it("makes parallel extension tools exclusive under strictExtensionClaims", () => {
		const toolPolicies: Map<string, "sequential" | "parallel"> = new Map([["custom", "parallel"]]);
		expect(
			resolveToolClaims(
				{ name: "custom", arguments: { value: 1 } },
				{
					cwd,
					toolPolicies,
					strictExtensionClaims: true,
				},
			),
		).toEqual(exclusive());
	});

	it("treats sequential-policy tools as exclusive", () => {
		const toolPolicies: Map<string, "sequential" | "parallel"> = new Map([["custom", "sequential"]]);
		expect(resolveToolCallsExclusiveWithPolicies("custom", { value: 1 }, toolPolicies));
	});

	it("fails closed to exclusive for path tools with invalid arguments", () => {
		expect(resolveToolCallsExclusive("write", {}));
		expect(resolveToolCallsExclusive("read", { path: "" }));
		expect(resolveToolCallsExclusive("edit", { path: "   " }));
	});

	it("fails closed to exclusive for non-object arguments", () => {
		for (const name of ["read", "grep", "find", "ls"]) {
			expect(resolveToolCallsExclusive(name, undefined));
			expect(resolveToolCallsExclusive(name, null));
			expect(resolveToolCallsExclusive(name, ["a"]));
		}
	});
});

function resolveToolCallsExclusive(name: string, args: unknown): boolean {
	const resolution = resolveToolClaims({ name, arguments: args }, { cwd });
	expect(resolution).toEqual(exclusive());
	return true;
}

function resolveToolCallsExclusiveWithPolicies(
	name: string,
	args: unknown,
	toolPolicies: Map<string, "sequential" | "parallel">,
): boolean {
	const resolution = resolveToolClaims({ name, arguments: args }, { cwd, toolPolicies });
	expect(resolution).toEqual(exclusive());
	return true;
}

describe("identity-key aware path conflicts (ALG002-A)", () => {
	it("conflicts when write claims share a realKey even with disjoint lexical keys", () => {
		const viaLink: ToolResourceClaim = {
			kind: "path",
			key: "/repo/current/a.ts",
			access: "write",
			realKey: "/repo/releases/42/a.ts",
		};
		const direct: ToolResourceClaim = {
			kind: "path",
			key: "/repo/releases/42/a.ts",
			access: "write",
			realKey: "/repo/releases/42/a.ts",
		};
		expect(claimsConflict(viaLink, direct)).toBe(true);
		// Same alias pair stays parallel for read/read.
		expect(claimsConflict({ ...viaLink, access: "read" }, { ...direct, access: "read" })).toBe(false);
	});

	it("conflicts when a resolved realKey overlaps the other claim's lexical key", () => {
		const resolved: ToolResourceClaim = {
			kind: "path",
			key: "/repo/current/a.ts",
			access: "write",
			realKey: "/repo/releases/42/a.ts",
		};
		const lexicalOnly: ToolResourceClaim = { kind: "path", key: "/repo/releases/42/a.ts", access: "write" };
		expect(claimsConflict(resolved, lexicalOnly)).toBe(true);
		expect(claimsConflict(lexicalOnly, resolved)).toBe(true);
	});

	it("conflicts when write claims share an inode identity (hardlinks)", () => {
		const a: ToolResourceClaim = { kind: "path", key: "/repo/hardlink-a", access: "write", inodeKey: "9:77" };
		const b: ToolResourceClaim = { kind: "path", key: "/repo/hardlink-b", access: "write", inodeKey: "9:77" };
		expect(claimsConflict(a, b)).toBe(true);
		expect(claimsConflict({ ...a, inodeKey: "9:78" }, b)).toBe(false);
	});

	it("attaches resolver identity keys to built-in path claims and isolates resolver errors", async () => {
		const resolver = {
			resolvePath: async (rawPath: string) => {
				if (rawPath.includes("boom")) throw new Error("resolver failed");
				return {
					lexicalKey: rawPath,
					realKey: rawPath.replace("/current/", "/releases/42/"),
					inodeKey: "1:2",
				};
			},
		};
		const enriched = await resolveToolClaimsForCall(
			{ name: "write", arguments: { path: "/repo/current/a.ts", content: "" } },
			{ cwd, resourceKeyResolver: resolver },
		);
		expect(enriched).toEqual({
			kind: "claims",
			claims: [
				{
					kind: "path",
					key: "/repo/current/a.ts",
					access: "write",
					realKey: "/repo/releases/42/a.ts",
					inodeKey: "1:2",
				},
			],
		});

		// Resolver failure isolates the call so no unresolved alias can race.
		const fallback = await resolveToolClaimsForCall(
			{ name: "write", arguments: { path: "/repo/boom/a.ts", content: "" } },
			{ cwd, resourceKeyResolver: resolver },
		);
		expect(fallback).toEqual(exclusive());
	});

	it("canonicalizes identity keys deterministically regardless of claim order", () => {
		const a: ToolResourceClaim = { kind: "path", key: "/a.ts", access: "read", inodeKey: "1:1" };
		const b: ToolResourceClaim = { kind: "path", key: "/a.ts", access: "read", realKey: "/real/a.ts" };
		expect(canonicalizeClaims([a, b])).toEqual(canonicalizeClaims([b, a]));
	});
});
