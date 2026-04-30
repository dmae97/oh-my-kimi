/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/823.
 *
 * On WSL (and any host where the user moves the standalone binary away from the
 * build-time native artifacts), the compiled `omp` binary fails to load
 * `pi_natives.linux-x64-*.node`. Root cause: the loader's `isCompiledBinary`
 * detection in `packages/natives/native/index.js` relies on
 *   - `process.env.PI_COMPILED` — never set, because `bun build --compile
 *     --define PI_COMPILED=true` substitutes the bare identifier, not
 *     property accesses on `process.env`.
 *   - `__filename.includes("$bunfs"|"~BUN"|"%7EBUN")` — Bun's compiled
 *     binaries keep the original build-host absolute path in `__filename`
 *     (only `import.meta.url` is rewritten to the bunfs URL).
 *
 * Both signals are false at runtime, so the loader skips the embedded-addon
 * extraction path and only tries `nativeDir` (the dev machine's checkout) and
 * `execDir`. On WSL with `~/.local/bin/omp` and no sibling `.node` file, this
 * fails with the error reported in the issue.
 *
 * The fix is to make the loader's compiled-binary detection authoritative on
 * the embedded-addon module presence (the embedded-addon stub exports `null`
 * outside of `--compile`, and is regenerated to a populated object during the
 * standalone build), and to expose the candidate-path computation as a pure
 * helper so it can be tested host-agnostically.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { detectCompiledBinary, getAddonFilenames, resolveLoaderCandidates } from "../native/loader-state";

describe("issue 823: standalone-binary native loader path resolution", () => {
	it("detects compiled-binary mode from embedded-addon presence when env and url markers are absent", () => {
		// Mirrors what a Bun standalone binary actually sees on linux-x64 / WSL:
		// - `process.env.PI_COMPILED` is undefined (the build flag does not substitute property accesses).
		// - `import.meta.url` does point at `$bunfs` for the entrypoint, but a CJS native loader
		//   that lives in a required module historically read `__filename`, which is NOT rewritten.
		// The embedded-addon module is the authoritative compiled-mode signal: it is `null` in
		// development (the stub) and a populated object in the standalone build (after
		// `embed:native` runs), and is bundled into the binary by `bun build --compile`.
		expect(
			detectCompiledBinary({
				embeddedAddon: {
					platformTag: "linux-x64",
					version: "14.5.2",
					files: [
						{
							variant: "modern",
							filename: "pi_natives.linux-x64-modern.node",
							filePath: "/$bunfs/root/packages/natives/native/pi_natives.linux-x64-modern.node",
						},
					],
				},
				env: {},
				importMetaUrl: "/home/u/build-host/packages/natives/native/index.js",
			}),
		).toBe(true);

		// Without an embedded-addon and without env/url markers, we are NOT compiled.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "/home/u/dev/packages/natives/native/index.js",
			}),
		).toBe(false);

		// Env override (e.g. user-set PI_COMPILED=1) still wins.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: { PI_COMPILED: "1" },
				importMetaUrl: "/anywhere",
			}),
		).toBe(true);

		// `import.meta.url` bunfs marker still wins when present.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "file:///$bunfs/root/cli",
			}),
		).toBe(true);
	});

	it("places embedded-extracted candidates ahead of build-host candidates for linux-x64 standalone", () => {
		const versionedDir = "/home/u/.omp/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const nativeDir = "/build-host/packages/natives/native";
		const execDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern" }),
			isCompiledBinary: true,
			nativeDir,
			execDir,
			versionedDir,
			userDataDir,
		});

		const versionedModern = path.join(versionedDir, "pi_natives.linux-x64-modern.node");
		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const userDataModern = path.join(userDataDir, "pi_natives.linux-x64-modern.node");
		const buildHostModern = path.join(nativeDir, "pi_natives.linux-x64-modern.node");

		// Versioned cache and user-data dir candidates must exist for compiled binaries —
		// these are where the embedded-addon extraction lands (~/.omp/natives/<v>) and where
		// `omp update` writes the standalone binary on linux (~/.local/bin).
		expect(candidates).toContain(versionedModern);
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(userDataModern);

		// Order matters: embedded-extracted destinations must be probed before the
		// (potentially-missing) build-host nativeDir path that survives in __dirname.
		expect(candidates.indexOf(versionedModern)).toBeLessThan(candidates.indexOf(buildHostModern));
	});

	it("does not probe user-data candidates when running outside a standalone binary", () => {
		const versionedDir = "/home/u/.omp/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			nativeDir: "/repo/packages/natives/native",
			execDir: "/usr/bin",
			versionedDir,
			userDataDir,
		});
		expect(candidates).not.toContain(path.join(versionedDir, "pi_natives.linux-x64-baseline.node"));
		expect(candidates).not.toContain(path.join(userDataDir, "pi_natives.linux-x64-baseline.node"));
	});
});
