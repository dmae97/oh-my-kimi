import { describe, expect, it } from "vitest";
import {
	type RegisteredToolClaimDefinition,
	resolutionsConflict,
	resolveToolClaims,
	resolveToolClaimsForCall,
	type ToolClaimResolution,
	type ToolResourceClaim,
	type ToolResourceClaims,
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

describe("resolve registered tool claims", () => {
	it("passes raw args and scheduler context to a synchronous custom resolver", async () => {
		let received: { args: unknown; context: { cwd: string; toolCallId: string } } | undefined;
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "extension_write",
				resourceClaims: (args, context) => {
					received = { args, context };
					return [{ kind: "global", key: "alpha", access: "write" }];
				},
			},
		];

		await expect(
			resolveToolClaimsForCall(
				{ id: "call-7", name: "extension_write", arguments: { target: "alpha" } },
				{ cwd, registeredTools },
			),
		).resolves.toEqual(claims(claim("write", "alpha", "global")));
		expect(received).toEqual({ args: { target: "alpha" }, context: { cwd, toolCallId: "call-7" } });
	});

	it("awaits promise-returning resolvers", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "async_extension",
				resourceClaims: async () => [{ kind: "session", key: "shared", access: "write" }],
			},
		];
		await expect(
			resolveToolClaimsForCall({ id: "async-1", name: "async_extension", arguments: {} }, { cwd, registeredTools }),
		).resolves.toEqual(claims(claim("write", "shared", "session")));
	});

	it("fails closed when a resolver throws or rejects", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "throws",
				resourceClaims: () => {
					throw new Error("claim failure");
				},
			},
			{
				name: "rejects",
				resourceClaims: () => Promise.reject(new Error("claim rejection")),
			},
		];
		await expect(
			resolveToolClaimsForCall({ id: "a", name: "throws", arguments: {} }, { cwd, registeredTools }),
		).resolves.toEqual(exclusive());
		await expect(
			resolveToolClaimsForCall({ id: "b", name: "rejects", arguments: {} }, { cwd, registeredTools }),
		).resolves.toEqual(exclusive());
	});

	it("fails closed for malformed, empty, and partly invalid claims", async () => {
		const malformedClaim: ToolResourceClaim = { kind: "global", key: "x", access: "write" };
		Reflect.set(malformedClaim, "kind", "invalid");
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{ name: "malformed", resourceClaims: () => [malformedClaim] },
			{ name: "empty", resourceClaims: () => [] },
			{
				name: "partial",
				resourceClaims: (() => [
					{ kind: "global", key: "valid", access: "write" },
					{ kind: "global", key: "", access: "read" },
				]) as () => ToolResourceClaims,
			},
		];

		for (const name of ["malformed", "empty", "partial"]) {
			await expect(
				resolveToolClaimsForCall({ id: name, name, arguments: {} }, { cwd, registeredTools }),
			).resolves.toEqual(exclusive());
		}
	});

	it("normalizes custom relative read/write paths against cwd before conflict checks", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_read",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "read" }],
			},
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const customRead = await resolveToolClaimsForCall(
			{ name: "custom_read", arguments: {} },
			{ cwd, registeredTools },
		);
		const customWrite = await resolveToolClaimsForCall(
			{ name: "custom_write", arguments: {} },
			{ cwd, registeredTools },
		);
		const builtInRead = resolveToolClaims({ name: "read", arguments: { path: "/proj/a.ts" } }, { cwd });
		const builtInWrite = resolveToolClaims({ name: "write", arguments: { path: "/proj/a.ts" } }, { cwd });

		expect(customRead).toEqual(claims(claim("read", "/proj/a.ts")));
		expect(customWrite).toEqual(claims(claim("write", "/proj/a.ts")));
		expect(resolutionsConflict(customRead, builtInWrite)).toBe(true);
		expect(resolutionsConflict(customWrite, builtInRead)).toBe(true);
	});

	it("keeps normalized custom relative paths disjoint from other absolute paths", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const customWrite = await resolveToolClaimsForCall(
			{ name: "custom_write", arguments: {} },
			{ cwd, registeredTools },
		);
		const builtInWrite = resolveToolClaims({ name: "write", arguments: { path: "/proj/b.ts" } }, { cwd });

		expect(resolutionsConflict(customWrite, builtInWrite)).toBe(false);
	});

	it("normalizes a Windows relative custom path against a drive cwd", async () => {
		const windowsCwd = "C:\\proj";
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_write",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		const customWrite = await resolveToolClaimsForCall(
			{ name: "custom_write", arguments: {} },
			{ cwd: windowsCwd, registeredTools },
		);
		const builtInRead = resolveToolClaims(
			{ name: "read", arguments: { path: "C:\\proj\\a.ts" } },
			{ cwd: windowsCwd },
		);

		expect(customWrite).toEqual(claims(claim("write", "C:/proj/a.ts")));
		expect(resolutionsConflict(customWrite, builtInRead)).toBe(true);
	});

	it("fails closed for UNC, drive-relative, and root-escaping custom paths", async () => {
		for (const key of ["\\\\server\\share\\a.ts", "C:a.ts", "../../escape.ts"]) {
			const registeredTools: RegisteredToolClaimDefinition[] = [
				{
					name: "custom_path",
					resourceClaims: () => [{ kind: "path", key, access: "write" }],
				},
			];
			await expect(
				resolveToolClaimsForCall({ name: "custom_path", arguments: {} }, { cwd, registeredTools }),
			).resolves.toEqual(exclusive());
		}
	});

	it("fails closed for a custom relative path under a malformed cwd", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "custom_path",
				resourceClaims: () => [{ kind: "path", key: "a.ts", access: "write" }],
			},
		];
		for (const invalidCwd of ["", "relative/cwd", "C:relative", "\\\\server\\share"]) {
			await expect(
				resolveToolClaimsForCall({ name: "custom_path", arguments: {} }, { cwd: invalidCwd, registeredTools }),
			).resolves.toEqual(exclusive());
		}
	});

	it("turns a valid exclusive-access claim into an exclusive resolution", async () => {
		const registeredTools: RegisteredToolClaimDefinition[] = [
			{
				name: "terminal_extension",
				resourceClaims: () => [{ kind: "terminal", key: "tty", access: "exclusive" }],
			},
		];
		await expect(
			resolveToolClaimsForCall(
				{ id: "terminal-1", name: "terminal_extension", arguments: {} },
				{ cwd, registeredTools },
			),
		).resolves.toEqual(exclusive());
	});
});
