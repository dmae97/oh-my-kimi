import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { __resolveTypeBoxShimPath } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

/**
 * Defensive tier for issue #3414.
 *
 * Even with the entrypoint list pinned in `binary-entrypoints.ts`, a future
 * Bun `--compile` regression (cf. #2168) can silently drop the typebox shim
 * file from bunfs. Without runtime validation the resolver would emit a
 * `file://` URL to a path that no longer exists and plugin loads fail with
 * `Cannot find module '/$bunfs/root/.../typebox.js'`.
 *
 * `__resolveTypeBoxShimPath` mirrors the `__validateLegacyPiPackageRootOverrides`
 * fallback already in place for the legacy package-root overrides: if the
 * computed candidate is missing, return `null` so the rewriter leaves bare
 * `typebox` / `@sinclair/typebox` specifiers alone and Bun resolves a real
 * install from the extension's own `node_modules`.
 */
describe("legacy pi-compat typebox shim path validation (issue #3414)", () => {
	const stubMetaDir = "/repo/packages/coding-agent/src/extensibility/plugins";

	it("returns the bunfs candidate when --compile bundled the shim", () => {
		const result = __resolveTypeBoxShimPath(
			"/$bunfs/root/packages",
			undefined,
			"/$bunfs/root",
			() => true,
			path.posix,
		);
		expect(result).toBe("/$bunfs/root/packages/coding-agent/src/extensibility/typebox.js");
	});

	it("drops the bunfs candidate when --compile silently omitted the shim", () => {
		const result = __resolveTypeBoxShimPath(
			"/$bunfs/root/packages",
			undefined,
			"/$bunfs/root",
			() => false,
			path.posix,
		);
		expect(result).toBeNull();
	});

	it("preserves the double-slash bunfs prefix on cross-compiled darwin-arm64 (issue #3329)", () => {
		// `BUNFS_PACKAGE_ROOT` on the cross-compiled release is `//root/packages`.
		// The shim path must keep that exact double-slash mount prefix so Bun's
		// bunfs lookup matches.
		const result = __resolveTypeBoxShimPath(
			"//root/packages",
			undefined,
			"//root/omp-darwin-arm64",
			() => true,
			path.posix,
		);
		expect(result).toBe("//root/packages/coding-agent/src/extensibility/typebox.js");
	});

	it("returns the npm prebuilt dist path when PI_BUNDLED is set", () => {
		const bundledRoot = "/home/me/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent";
		const result = __resolveTypeBoxShimPath(null, bundledRoot, stubMetaDir, () => true, path.posix);
		expect(result).toBe(`${bundledRoot}/src/extensibility/typebox.ts`);
	});

	it("returns the dev source path when neither bunfs nor bundled is set", () => {
		const result = __resolveTypeBoxShimPath(null, undefined, stubMetaDir, () => true, path.posix);
		expect(result).toBe("/repo/packages/coding-agent/src/extensibility/typebox.ts");
	});

	it("returns null when the dev source path is missing too", () => {
		const result = __resolveTypeBoxShimPath(null, undefined, stubMetaDir, () => false, path.posix);
		expect(result).toBeNull();
	});
});
