import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1011
 *
 * In v14.5.13 `spawnTabWorker` (in `src/tools/browser/tab-supervisor.ts`)
 * resolved the worker entry as `new URL("./tab-worker-entry.ts", import.meta.url)`
 * and passed `.href` to `new Worker(...)`. Bun's `--compile` static analyzer
 * cannot discover that pattern, so the entry was never embedded in the
 * single-file binary and the runtime symptom was "Timed out initializing
 * browser tab worker".
 *
 * The original fix used an `import "./worker.ts" with { type: "file" }`
 * trick. That copied the entry as a raw asset but could not resolve its
 * relative imports inside the compiled binary, so the worker still failed
 * to load (issue #1027 was the same root cause, retriggered).
 *
 * The current contract is simpler: when the process was started from the omp
 * CLI (source, npm bundle, or compiled binary), spawn sites re-enter the
 * declared worker-host entry — `new Worker(workerHostEntry(), { argv })` — and
 * the CLI dispatches the hidden argv selector. Outside a CLI host (bun test,
 * SDK embedding) they load the worker module directly. No separate worker
 * module is ever bundled or listed as a `--compile` entrypoint.
 */
describe("issue #1011 — tab worker must re-enter the CLI entrypoint", () => {
	const packageDir = path.resolve(import.meta.dir, "..");
	const supervisorPath = path.join(packageDir, "src/tools/browser/tab-supervisor.ts");
	const buildBinaryPath = path.join(packageDir, "scripts/build-binary.ts");
	const workerArg = "__omp_worker_tab";

	it("tab-supervisor re-enters the worker-host entry with the argv selector", async () => {
		const source = await Bun.file(supervisorPath).text();

		expect(
			source.includes("workerHostEntry()"),
			"tab-supervisor.ts must spawn via the declared worker-host entry",
		).toBe(true);
		expect(source).toContain(`argv: ["${workerArg}"]`);
		expect(
			source.includes('new URL("./tab-worker-entry.ts", import.meta.url)'),
			"tab-supervisor.ts must keep the direct-module fallback for non-CLI hosts",
		).toBe(true);
	});

	it("build-binary.ts no longer lists tab-worker-entry as a separate --compile entrypoint", async () => {
		const source = await Bun.file(buildBinaryPath).text();
		expect(source).not.toContain("./src/tools/browser/tab-worker-entry.ts");
	});
});
