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
 * The current contract is simpler: every Worker re-enters the CLI entrypoint
 * and selects its worker body via `WorkerOptions.argv`, so release builds no
 * longer need to list the worker modules as extra `--compile` entrypoints.
 * Runtime coverage lives in `omp --smoke-test`.
 */
describe("issue #1150 — release/dev builds route workers through the CLI entrypoint", () => {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const ciScriptPath = path.join(repoRoot, "scripts/ci-release-build-binaries.ts");
	const devScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/build-binary.ts");

	// Repo-root-relative CLI literal — every runtime worker spawn site uses this
	// same entry plus a hidden argv selector.
	const workerEntrypoints = [
		"./packages/stats/src/sync-worker.ts",
		"./packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
		"./packages/coding-agent/src/eval/js/worker-entry.ts",
	];

	it("release/dev build scripts do not list worker modules as explicit --compile entrypoints", async () => {
		const releaseSource = await Bun.file(ciScriptPath).text();
		const devSource = await Bun.file(devScriptPath).text();
		for (const entry of workerEntrypoints) {
			expect(releaseSource).not.toContain(`"${entry}"`);
		}
		for (const entry of [
			"../stats/src/sync-worker.ts",
			"./src/tools/browser/tab-worker-entry.ts",
			"./src/eval/js/worker-entry.ts",
		]) {
			expect(devSource).not.toContain(`"${entry}"`);
		}
	});
});
