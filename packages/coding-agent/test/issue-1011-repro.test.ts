import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1011
 *
 * In v14.5.13 `spawnTabWorker` (in `src/tools/browser/tab-supervisor.ts`) was
 * introduced to host browser tabs in a `Worker`. The worker URL was assembled
 * as:
 *
 * ```ts
 * const url = new URL("./tab-worker-entry.ts", import.meta.url);
 * const worker = new Worker(url.href, { type: "module" });
 * ```
 *
 * Bun's `--compile` bundler does NOT statically discover that pattern (the
 * worker entry is hidden behind a local variable and `.href`), so the entry
 * file is never embedded in the single-file binary. At runtime the worker
 * thread tries to load `/$bunfs/root/tab-worker-entry.ts`, the module is
 * missing, and the supervisor surfaces the symptom from the issue:
 * `Timed out initializing browser tab worker`.
 *
 * `Bun.build` exposes the same static-analysis pass that drives `--compile`.
 * If `tab-worker-entry.ts` is reachable to the bundler, it appears in the
 * outputs as a separate `asset` chunk. If the spawn pattern hides it from
 * the bundler, only the entry point is emitted.
 *
 * The bundler is driven through a `bun -e` subprocess that writes its report
 * to a tmp file: invoking `Bun.build` directly from inside `bun test` does
 * not auto-resolve TypeScript imports the way the real build pipeline does.
 */
describe("issue #1011 — tab worker entry must survive `bun build --compile`", () => {
	it("bundles tab-worker-entry.ts as a discoverable asset of tab-supervisor.ts", async () => {
		const supervisor = path.resolve(import.meta.dir, "../src/tools/browser/tab-supervisor.ts");
		const packageDir = path.resolve(import.meta.dir, "..");
		const reportPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "issue-1011-")), "report.json");
		const script = `const r = await Bun.build({ entrypoints: [${JSON.stringify(supervisor)}], target: "bun" }); await Bun.write(${JSON.stringify(reportPath)}, JSON.stringify({ success: r.success, outputs: r.outputs.map(o => ({ path: o.path, kind: o.kind })), logs: r.logs.map(l => l.message) }));`;
		const proc = Bun.spawnSync(["bun", "-e", script], {
			cwd: packageDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = proc.stderr.toString();
		expect(proc.exitCode, `bun -e exited with ${proc.exitCode}; stderr=${stderr}`).toBe(0);

		const report = (await Bun.file(reportPath).json()) as {
			success: boolean;
			outputs: { path: string; kind: string }[];
			logs: string[];
		};
		expect(report.success, `bundler logs: ${report.logs.join("; ")}`).toBe(true);

		const workerAssets = report.outputs.filter(out => out.kind === "asset" && out.path.includes("tab-worker-entry"));
		if (workerAssets.length === 0) {
			const summary = report.outputs.map(o => `${o.kind}:${o.path}`).join(", ");
			throw new Error(
				`tab-worker-entry.ts was not bundled as an asset of tab-supervisor.ts. ` +
					`Bun's --compile bundler cannot embed the worker because the Worker ` +
					`constructor argument is not a statically-analyzable URL literal. ` +
					`Bundler outputs were: [${summary}]`,
			);
		}
	});
});
