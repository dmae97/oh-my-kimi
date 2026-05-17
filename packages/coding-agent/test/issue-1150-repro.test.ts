import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1150
 *
 * In v15.1.3 `omp stats` crashed in the published Linux/macOS/Windows
 * binaries with `BuildMessage: ModuleNotFound resolving
 * "./packages/stats/src/sync-worker.ts" (entry point)`. The dev-mode build
 * script `packages/coding-agent/scripts/build-binary.ts` listed the three
 * worker entrypoints required by AGENTS.md, but the release script
 * `scripts/ci-release-build-binaries.ts` — the one that actually builds the
 * shipped artifacts — did not. The `new Worker("./packages/<pkg>/src/...")`
 * literal at the spawn site fooled Bun's `--compile` static analyzer into
 * keeping the call site, but without the matching `--compile` entrypoint
 * the worker module was never emitted into bunfs and the runtime tried to
 * bundle it on the fly, which fails in `$bunfs`.
 *
 * The contract from AGENTS.md is symmetric: **every** worker spawned via
 * the `isCompiledBinary()` hybrid pattern must be listed as an extra
 * `--compile` entry in **both** scripts. This test pins that contract for
 * the release script; the dev script is covered by `issue-1011-repro` for
 * the tab worker entry. Runtime coverage lives in `omp --smoke-test`,
 * which the release-binary CI step now invokes.
 */
describe("issue #1150 — release-build script must list all worker --compile entrypoints", () => {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const ciScriptPath = path.join(repoRoot, "scripts/ci-release-build-binaries.ts");
	const devScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/build-binary.ts");

	// Repo-root-relative literals — both the runtime `new Worker(...)`
	// spawn site and the `--compile` entry must use this exact string for
	// Bun's static analyzer to match them up.
	const workerEntrypoints = [
		"./packages/stats/src/sync-worker.ts",
		"./packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
		"./packages/coding-agent/src/eval/js/worker-entry.ts",
	];

	it("scripts/ci-release-build-binaries.ts lists every worker as an explicit --compile entrypoint", async () => {
		const source = await Bun.file(ciScriptPath).text();
		for (const entry of workerEntrypoints) {
			expect(
				source.includes(`"${entry}"`),
				`scripts/ci-release-build-binaries.ts must include "${entry}" as a --compile entrypoint so Bun emits the worker into bunfs in the published binary`,
			).toBe(true);
		}
	});

	it("packages/coding-agent/scripts/build-binary.ts lists every worker as an explicit --compile entrypoint", async () => {
		// Dev script's cwd is packages/coding-agent and its `--root ../..`
		// resolves to repo root, so its entry strings are package-relative
		// (not repo-relative) but produce the same bunfs path.
		const devEntrypoints = [
			"../stats/src/sync-worker.ts",
			"./src/tools/browser/tab-worker-entry.ts",
			"./src/eval/js/worker-entry.ts",
		];
		const source = await Bun.file(devScriptPath).text();
		for (const entry of devEntrypoints) {
			expect(
				source.includes(`"${entry}"`),
				`packages/coding-agent/scripts/build-binary.ts must include "${entry}" as a --compile entrypoint so dev binaries match release binaries`,
			).toBe(true);
		}
	});
});
