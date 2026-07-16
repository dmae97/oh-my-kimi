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
			`setTransports({ file: false });\n`,
	);
	return probePath;
}

async function waitForExit(proc: Bun.Subprocess): Promise<number> {
	const code = await proc.exited;
	return code;
}

describe("multiprocess file logging", () => {
	it("gives concurrent processes independent rotation files and audit state", async () => {
		const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-output-"));
		roots.push(logsDir);
		const probePath = await makeProbe(logsDir);
		const processes = [
			Bun.spawn([process.execPath, probePath], { stdout: "ignore", stderr: "pipe" }),
			Bun.spawn([process.execPath, probePath], { stdout: "ignore", stderr: "pipe" }),
		];

		expect(await Promise.all(processes.map(waitForExit))).toEqual([0, 0]);
		const entries = await fs.readdir(logsDir);
		const datedPrefix = `omp.${new Date().toISOString().slice(0, 10)}`;
		for (const proc of processes) {
			expect(entries).toContain(`${datedPrefix}.${proc.pid}.log`);
		}
		expect(entries.filter(name => name.endsWith("-audit.json"))).toHaveLength(2);
	});
});
