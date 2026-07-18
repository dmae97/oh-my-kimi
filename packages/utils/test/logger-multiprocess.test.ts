import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const loggerModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/logger.ts")).href;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeProbe(logsDir: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-probe-"));
	roots.push(root);
	const probePath = path.join(root, "probe.ts");
	await Bun.write(
		probePath,
		`import { info, setTransports } from ${JSON.stringify(loggerModuleUrl)};\n` +
			`setTransports({ file: ${JSON.stringify(logsDir)} });\n` +
			`info("multiprocess probe");\n` +
			`console.log("ready");\n` +
			`await new Response(Bun.stdin.stream()).text();\n` +
			`setTransports({ file: false });\n`,
	);
	return probePath;
}

describe("multiprocess file logging", () => {
	it("gives concurrent processes independent rotation files and audit state", async () => {
		const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-output-"));
		roots.push(logsDir);
		const probePath = await makeProbe(logsDir);
		const processes = [
			Bun.spawn([process.execPath, probePath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
			Bun.spawn([process.execPath, probePath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		];

		const ready = await Promise.all(
			processes.map(async proc => {
				const reader = proc.stdout.getReader();
				const result = await reader.read();
				reader.releaseLock();
				return result.value ? new TextDecoder().decode(result.value) : "";
			}),
		);
		expect(ready).toEqual(["ready\n", "ready\n"]);
		for (const proc of processes) proc.stdin.end();

		expect(await Promise.all(processes.map(proc => proc.exited))).toEqual([0, 0]);
		const entries = await fs.readdir(logsDir);
		const datedPrefix = `omp.${new Date().toISOString().slice(0, 10)}`;
		for (const proc of processes) {
			expect(entries).toContain(`${datedPrefix}.${proc.pid}.log`);
		}
		expect(entries.filter(name => name.endsWith("-audit.json"))).toHaveLength(2);
	});

	it("prunes completed PID namespaces across short-lived invocations", async () => {
		const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-retention-"));
		roots.push(logsDir);
		const exited = Array.from({ length: 7 }, () =>
			Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" }),
		);
		expect(await Promise.all(exited.map(proc => proc.exited))).toEqual(Array(7).fill(0));

		const date = "2026-07-01";
		for (const [index, proc] of exited.entries()) {
			const logPath = path.join(logsDir, `omp.${date}.${proc.pid}.log`);
			await Bun.write(logPath, `completed process ${proc.pid}`);
			await fs.utimes(logPath, index + 1, index + 1);
			await Bun.write(path.join(logsDir, `.omp.${proc.pid}-audit.json`), "{}");
		}

		const probePath = await makeProbe(logsDir);
		const current = Bun.spawn([process.execPath, probePath], { stdout: "ignore", stderr: "pipe" });
		expect(await current.exited).toBe(0);

		const entries = await fs.readdir(logsDir);
		const completedLogs = entries.filter(name => name.startsWith(`omp.${date}.`));
		expect(completedLogs).toHaveLength(5);
		expect(entries.filter(name => name.endsWith("-audit.json"))).toEqual([`.omp.${current.pid}-audit.json`]);
	});
});
