import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
}

const pythonPath = Bun.env.PYTHON ?? "python3";
const runnerPath = path.resolve(import.meta.dir, "..", "runner.py");
const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const encoder = new TextEncoder();

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runCell(code: string): Promise<RunnerFrame[]> {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
		},
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const frames: RunnerFrame[] = [];

	async function readFrame(): Promise<RunnerFrame> {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				return JSON.parse(line) as RunnerFrame;
			}
			const { value, done } = await reader.read();
			if (done) {
				throw new Error(`Python runner exited before done frame: ${await stderr}`);
			}
			pending += decoder.decode(value, { stream: true });
		}
	}

	try {
		proc.stdin.write(encoder.encode(`${JSON.stringify({ id: "r1", code })}\n`));
		proc.stdin.flush();
		while (true) {
			const frame = await readFrame();
			frames.push(frame);
			if (frame.type === "done") break;
		}
		proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`Python runner exited ${exitCode}: ${await stderr}`);
		}
		return frames;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released by stream closure.
		}
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

describe("Python runner shell output streaming", () => {
	it("streams !cmd output chunks before the child process exits", async () => {
		const child = [
			"import sys,time",
			"sys.stdout.write('first\\n')",
			"sys.stdout.flush()",
			"time.sleep(0.2)",
			"sys.stdout.write('second\\n')",
			"sys.stdout.flush()",
		].join(";");
		const frames = await runCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('return=' + str(result.returncode) + ' lines=' + repr(list(result)))",
			].join("\n"),
		);
		const stdout = frames.filter(frame => frame.type === "stdout").map(frame => frame.data);

		expect(stdout[0]).toBe("first\n");
		expect(stdout.join("")).toContain("second\n");
		expect(stdout.join("")).toContain("return=0 lines=['first', 'second']");
	});

	it("streams newline-free %%bash output without waiting for EOF", async () => {
		const child = [
			"import sys,time",
			"sys.stdout.write('first')",
			"sys.stdout.flush()",
			"time.sleep(0.2)",
			"sys.stdout.write('second')",
			"sys.stdout.flush()",
		].join(";");
		const frames = await runCell(`%%bash\n${pythonPath} -c ${shellQuote(child)}`);
		const stdout = frames.filter(frame => frame.type === "stdout").map(frame => frame.data);

		expect(stdout[0]).toBe("first");
		expect(stdout.join("")).toBe("firstsecond");
	});
});
