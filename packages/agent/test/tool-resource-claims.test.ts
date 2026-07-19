import { describe, expect, it } from "vitest";
import {
	canonicalizeClaims,
	claimsConflict,
	resolutionsConflict,
	resolvePathClaimKey,
	resolveToolClaims,
	type ToolClaimResolution,
	type ToolResourceClaim,
} from "../src/tool-resource-claims.ts";

const cwd = "/proj";

function claim(access: "read" | "write", key: string, kind: ToolResourceClaim["kind"] = "path"): ToolResourceClaim {
	if (kind === "path") {
		return { access, kind, key };
	}
	return { access, kind, key };
}

function claims(...claims: ToolResourceClaim[]): ToolClaimResolution {
	return { kind: "claims", claims };
}

function exclusive(): ToolClaimResolution {
	return { kind: "exclusive" };
}

describe("claimsConflict matrix", () => {
	it("treats read/read on the same path as parallel (no conflict)", () => {
		expect(claimsConflict(claim("read", "/a.ts"), claim("read", "/a.ts"))).toBe(false);
	});

	it("treats read/write on the same path as a conflict", () => {
		expect(claimsConflict(claim("read", "/a.ts"), claim("write", "/a.ts"))).toBe(true);
		expect(claimsConflict(claim("write", "/a.ts"), claim("read", "/a.ts"))).toBe(true);
	});

	it("treats write/write on the same path as a conflict", () => {
		expect(claimsConflict(claim("write", "/a.ts"), claim("write", "/a.ts"))).toBe(true);
	});

	it("ignores disjoint paths even for write/write", () => {
		expect(claimsConflict(claim("write", "/a.ts"), claim("write", "/b.ts"))).toBe(false);
	});

	it("collapses aliasing paths via lexical overlap", () => {
		expect(claimsConflict(claim("write", "/a/b/../c.ts"), claim("write", "/a/c.ts"))).toBe(true);
		expect(claimsConflict(claim("read", "/a/B.ts"), claim("read", "/a/b.ts"))).toBe(false);
		expect(claimsConflict(claim("write", "/a/B.ts"), claim("read", "/a/b.ts"))).toBe(true);
	});

	it("treats a root write as conflicting with descendant access", () => {
		expect(claimsConflict(claim("write", "/"), claim("read", "/proj/a.ts"))).toBe(true);
	});

	it("preserves Windows drive roots for traversal and root overlap", () => {
		expect(claimsConflict(claim("write", "C:/../foo"), claim("read", "C:/foo"))).toBe(true);
		expect(claimsConflict(claim("write", "C:/"), claim("read", "C:/"))).toBe(true);
		expect(claimsConflict(claim("write", "C:/"), claim("read", "C:/foo"))).toBe(true);
		expect(claimsConflict(claim("write", "C:/foo"), claim("read", "D:/foo"))).toBe(false);
	});

	it("treats root-relative Windows claims as possible drive-absolute aliases", () => {
		expect(claimsConflict(claim("write", "/foo"), claim("read", "C:/foo"))).toBe(true);
	});

	it("never conflicts across different resource kinds", () => {
		expect(claimsConflict(claim("write", "x", "path"), claim("write", "x", "network"))).toBe(false);
	});

	it("compares non-path resource kinds by exact key equality", () => {
		expect(claimsConflict(claim("write", "db1", "global"), claim("read", "db1", "global"))).toBe(true);
		expect(claimsConflict(claim("write", "db1", "global"), claim("read", "db2", "global"))).toBe(false);
	});

	it("treats exclusive access as conflicting across kinds and keys", () => {
		const exclusiveClaim: ToolResourceClaim = { kind: "global", key: "one", access: "exclusive" };
		expect(claimsConflict(exclusiveClaim, claim("read", "two", "session"))).toBe(true);
	});
});

describe("resolutionsConflict", () => {
	it("exclusive conflicts with every resolution regardless of namespace", () => {
		expect(resolutionsConflict(exclusive(), claims(claim("read", "/a.ts")))).toBe(true);
		expect(resolutionsConflict(claims(claim("write", "k", "global")), exclusive())).toBe(true);
		expect(resolutionsConflict(exclusive(), exclusive())).toBe(true);
	});

	it("empty claim sets never conflict (freely parallel)", () => {
		expect(resolutionsConflict(claims(), claims())).toBe(false);
		expect(resolutionsConflict(claims(), claims(claim("write", "/a.ts")))).toBe(false);
	});

	it("any conflicting claim pair makes resolutions conflict", () => {
		expect(
			resolutionsConflict(
				claims(claim("read", "/a.ts"), claim("write", "k", "global")),
				claims(claim("read", "/b.ts"), claim("read", "k", "global")),
			),
		).toBe(true);
	});
});

describe("canonicalizeClaims", () => {
	it("sorts claims deterministically and is order-independent", () => {
		const a = canonicalizeClaims([claim("write", "/b.ts"), claim("read", "/a.ts")]);
		const b = canonicalizeClaims([claim("read", "/a.ts"), claim("write", "/b.ts")]);
		expect(a).toEqual(b);
		expect(a).toEqual([claim("read", "/a.ts"), claim("write", "/b.ts")]);
	});

	it("does not mutate the input", () => {
		const input = [claim("write", "/b.ts"), claim("read", "/a.ts")];
		canonicalizeClaims(input);
		expect(input).toEqual([claim("write", "/b.ts"), claim("read", "/a.ts")]);
	});
});

describe("resolvePathClaimKey", () => {
	it("joins relative paths against cwd without tilde expansion or fs", () => {
		expect(resolvePathClaimKey("read", { path: "src/foo.ts" }, cwd)).toBe("/proj/src/foo.ts");
	});

	it.each(["/abs/x.ts", "///abs/x.ts"])("canonicalizes the POSIX absolute alias %s", (path) => {
		expect(resolvePathClaimKey("write", { path }, cwd)).toBe("/abs/x.ts");
	});

	it("recognizes a normalized Windows drive path as absolute", () => {
		const windowsCwd = "C:\\proj";
		expect(resolvePathClaimKey("write", { path: "C:\\proj\\a.ts" }, windowsCwd)).toBe("C:/proj/a.ts");
		const absolute = resolveToolClaims({ name: "write", arguments: { path: "C:\\proj\\a.ts" } }, { cwd: windowsCwd });
		const relative = resolveToolClaims({ name: "read", arguments: { path: "a.ts" } }, { cwd: windowsCwd });
		expect(absolute).toEqual(claims(claim("write", "C:/proj/a.ts")));
		expect(relative).toEqual(claims(claim("read", "C:/proj/a.ts")));
		expect(resolutionsConflict(absolute, relative)).toBe(true);
	});

	it("canonicalizes Windows drive-root traversal without dropping the anchor", () => {
		const windowsCwd = "C:\\proj";
		expect(resolvePathClaimKey("write", { path: "C:\\..\\foo" }, windowsCwd)).toBe("C:/foo");
		expect(resolvePathClaimKey("read", { path: "C:\\" }, windowsCwd)).toBe("C:/");
	});

	it("anchors a Windows root-relative path to the cwd drive", () => {
		const windowsCwd = "C:\\proj";
		expect(resolvePathClaimKey("write", { path: "\\foo" }, windowsCwd)).toBe("C:/foo");
		const rootRelative = resolveToolClaims({ name: "write", arguments: { path: "\\foo" } }, { cwd: windowsCwd });
		const driveAbsolute = resolveToolClaims({ name: "read", arguments: { path: "C:\\foo" } }, { cwd: windowsCwd });
		expect(resolutionsConflict(rootRelative, driveAbsolute)).toBe(true);
	});

	it("fails closed for ambiguous Windows drive-relative paths", () => {
		const windowsCwd = "C:\\proj";
		expect(resolvePathClaimKey("write", { path: "C:foo" }, windowsCwd)).toBeNull();
		expect(resolveToolClaims({ name: "write", arguments: { path: "C:foo" } }, { cwd: windowsCwd })).toEqual(
			exclusive(),
		);
	});

	it("fails closed to null and exclusive for UNC paths", () => {
		const windowsCwd = "C:\\proj";
		for (const path of ["\\\\server\\share\\foo", "//server/share/foo"]) {
			expect(resolvePathClaimKey("write", { path }, windowsCwd)).toBeNull();
			expect(resolveToolClaims({ name: "write", arguments: { path } }, { cwd: windowsCwd })).toEqual(exclusive());
		}
	});

	it("does not expand tilde (unlike waves-v1)", () => {
		// Tilde is treated as a literal relative segment joined to cwd.
		expect(resolvePathClaimKey("read", { path: "~/foo.ts" }, cwd)).toBe("/proj/~/foo.ts");
	});

	it("fails closed to null for missing or blank path", () => {
		expect(resolvePathClaimKey("write", {}, cwd)).toBeNull();
		expect(resolvePathClaimKey("write", { path: "   " }, cwd)).toBeNull();
	});

	it("fails closed when cwd is not a canonical anchored path", () => {
		for (const invalidCwd of ["", "relative/cwd", "C:relative", "\\\\server\\share"]) {
			expect(resolvePathClaimKey("write", { path: "a.ts" }, invalidCwd)).toBeNull();
			expect(resolvePathClaimKey("write", { path: "/a.ts" }, invalidCwd)).toBeNull();
		}
	});

	it("returns null for a non-path-scoped tool", () => {
		expect(resolvePathClaimKey("web_search", { query: "x" }, cwd)).toBeNull();
	});
});
