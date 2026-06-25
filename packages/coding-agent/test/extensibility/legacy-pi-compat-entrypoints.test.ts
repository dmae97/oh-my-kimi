import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { LEGACY_COMPAT_BUILD_ENTRYPOINTS } from "../../../../scripts/binary-entrypoints";

/**
 * Regression for issue #3414.
 *
 * `legacy-pi-compat.ts` redirects bare `typebox` / `@sinclair/typebox` imports
 * and the legacy `@(scope)/pi-*` package roots onto computed bunfs paths under
 * `/$bunfs/root/packages/coding-agent/src/extensibility/` and
 * `/$bunfs/root/packages/<barrel>/...`. Bun's `--compile` static analyzer
 * never visits those literals, so each shim must be passed to `bun build` as
 * an extra entrypoint or it is silently omitted from bunfs and plugin loads
 * fail with `Cannot find module '/$bunfs/root/.../typebox.js'`.
 *
 * Commit `dc5c93462f` removed the worker entrypoints from
 * `scripts/ci-release-build-binaries.ts` but its inline comment falsely
 * claimed the legacy-shim entrypoints were "still" listed — they had never
 * been re-added. Released `omp-darwin-arm64` and `omp-linux-x64` shipped
 * without the shims, breaking every legacy pi plugin install.
 *
 * Contract pinned here:
 *   - Both build scripts (release CI + local dev) feed the SAME entrypoint
 *     list to `bun build --compile`, sourced from `binary-entrypoints.ts`.
 *   - That list covers every shim referenced by `legacy-pi-compat.ts`.
 */
describe("legacy pi-compat --compile entrypoints (issue #3414)", () => {
	const repoRoot = path.resolve(import.meta.dir, "../../../..");
	const ciScriptPath = path.join(repoRoot, "scripts/ci-release-build-binaries.ts");
	const devScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/build-binary.ts");
	const compatPath = path.join(repoRoot, "packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts");

	it("declares every shim file legacy-pi-compat redirects to as a --compile entrypoint", () => {
		// The shared constant must list every bunfs file the resolver hands back
		// to Bun. Drop one here and the corresponding plugin import breaks at
		// runtime with `Cannot find module '/$bunfs/root/...'`.
		expect(LEGACY_COMPAT_BUILD_ENTRYPOINTS).toEqual([
			"./packages/agent/src/index.ts",
			"./packages/natives/native/index.js",
			"./packages/tui/src/index.ts",
			"./packages/utils/src/index.ts",
			"./packages/coding-agent/src/extensibility/typebox.ts",
			"./packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts",
			"./packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
		]);
	});

	it("release and dev build scripts both source entrypoints from binary-entrypoints.ts", async () => {
		const releaseSource = await Bun.file(ciScriptPath).text();
		const devSource = await Bun.file(devScriptPath).text();

		// Both scripts import the shared constant rather than inlining their
		// own copy, so the two halves of the contract cannot drift apart.
		expect(releaseSource).toContain("import { LEGACY_COMPAT_BUILD_ENTRYPOINTS } from");
		expect(releaseSource).toContain("binary-entrypoints");
		expect(releaseSource).toContain("...LEGACY_COMPAT_BUILD_ENTRYPOINTS");

		expect(devSource).toContain("import { LEGACY_COMPAT_BUILD_ENTRYPOINTS } from");
		expect(devSource).toContain("binary-entrypoints");
		expect(devSource).toContain("...LEGACY_COMPAT_BUILD_ENTRYPOINTS");
	});

	it("each entrypoint actually exists on disk under the repo root", async () => {
		// `--compile` silently swallows a missing entrypoint when run without
		// `--root .` mismatches, then drops the file from bunfs and ships a
		// broken binary. Make every path a real file so the build fails loudly
		// if the constant ever lists a stale path.
		for (const relative of LEGACY_COMPAT_BUILD_ENTRYPOINTS) {
			const abs = path.join(repoRoot, relative.replace(/^\.\//, ""));
			expect(await Bun.file(abs).exists()).toBe(true);
		}
	});

	it("legacy-pi-compat.ts only redirects to shims declared in the entrypoint list", async () => {
		// Every `bunfsPath("<pkg>", "<entry>", ..., "<file>.js")` and
		// `bunfsPath("coding-agent", "src", "extensibility", "<shim>.js")` in
		// the compat module must have a corresponding `.ts` (or `.js`) entry
		// in `LEGACY_COMPAT_BUILD_ENTRYPOINTS`. Otherwise a plugin import goes
		// to a bunfs file that wasn't compiled in.
		const compatSource = await Bun.file(compatPath).text();
		const bunfsPathPattern = /bunfsPath\(([^)]+)\)/g;
		const segmentsList = [...compatSource.matchAll(bunfsPathPattern)]
			.map(match => match[1])
			.filter((segment): segment is string => typeof segment === "string");
		expect(segmentsList.length).toBeGreaterThan(0);

		for (const segmentsExpr of segmentsList) {
			const segments = [...segmentsExpr.matchAll(/"([^"]+)"/g)]
				.map(match => match[1])
				.filter((seg): seg is string => typeof seg === "string");
			if (segments.length === 0) continue;

			// Convert the bunfs path tail (e.g. `tui/src/index.js`) to the
			// matching repo-root build entrypoint (`./packages/tui/src/index.{ts,js}`).
			const bunfsTail = segments.join("/");
			const matched = LEGACY_COMPAT_BUILD_ENTRYPOINTS.some(entry => {
				const stripped = entry.replace(/^\.\/packages\//, "").replace(/\.(ts|js)$/, "");
				const bunfsExpected = bunfsTail.replace(/\.(js|ts)$/, "");
				return stripped === bunfsExpected;
			});
			expect(matched, `bunfsPath(${segmentsExpr}) has no matching --compile entrypoint`).toBe(true);
		}
	});
});
