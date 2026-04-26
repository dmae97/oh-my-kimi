import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import * as shellSnapshot from "@oh-my-pi/pi-coding-agent/utils/shell-snapshot";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-exec-"));
}

describe("executeBash", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		_resetSettingsForTest();
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("returns non-zero exit codes without cancellation", async () => {
		const result = await executeBash("exit 7", { cwd: tempDir, timeout: 5000 });
		expect(result.exitCode).toBe(7);
		expect(result.cancelled).toBe(false);
	});

	it("honors cwd", async () => {
		const result = await executeBash("pwd", { cwd: tempDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(tempDir));
	});

	it("canonicalizes symlinked cwd before execution", async () => {
		if (process.platform === "win32") {
			return;
		}

		const realDir = path.join(tempDir, "real");
		const linkDir = path.join(tempDir, "link");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir, "dir");

		const result = await executeBash("pwd", { cwd: linkDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(linkDir));
	});

	it("passes env vars", async () => {
		const result = await executeBash("echo $PI_TEST_ENV", {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("hello");
	});

	it("applies non-interactive environment defaults", async () => {
		const result = await executeBash('echo "$GIT_TERMINAL_PROMPT:$PI_TEST_ENV"', {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("0:hello");
	});

	it("invokes onChunk with command output", async () => {
		let seenChunk: string | null = null;
		const result = await executeBash("echo hello", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				if (seenChunk === null) {
					seenChunk = chunk;
				}
			},
		});
		expect(result.output.trim()).toBe("hello");
		expect(seenChunk).not.toBeNull();
		expect(seenChunk ?? "").toContain("hello");
	});

	it("returns even if command spawns a background job", async () => {
		if (process.platform === "win32") {
			return;
		}
		const start = Date.now();
		const result = await executeBash("{ sleep 5; } & echo fg", {
			cwd: tempDir,
			timeout: 5000,
		});
		expect(result.output).toContain("fg");
		expect(Date.now() - start).toBeLessThan(3000);
	});

	it("returns a real PID for background external commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		const result = await executeBash('python3 -c "import time; time.sleep(10)" & echo $!', {
			cwd: tempDir,
			timeout: 5000,
		});
		const pid = Number.parseInt(result.output.trim(), 10);
		expect(Number.isInteger(pid)).toBe(true);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(() => process.kill(pid, "SIGKILL")).not.toThrow();
	});

	it("times out commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
	});

	it("times out before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10; echo done", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
		expect(result.output).not.toContain("done");
	});

	it("aborts commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(50);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
	});

	it("aborts before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10; echo done", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		expect(result.output).not.toContain("done");
	});

	it("resets persistent session state after abort", async () => {
		if (process.platform === "win32") {
			return;
		}

		const sessionKey = "reset-on-abort";
		await executeBash("export PI_RESET_VAR=alive", { cwd: tempDir, timeout: 5000, sessionKey });
		const beforeAbort = await executeBash("echo $PI_RESET_VAR", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(beforeAbort.output.trim()).toBe("alive");

		const controller = new AbortController();
		const abortPromise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey,
		});
		await Bun.sleep(50);
		controller.abort();
		const aborted = await abortPromise;
		expect(aborted.cancelled).toBe(true);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a bash variable expansion
		const afterAbort = await executeBash("echo ${PI_RESET_VAR:-unset}", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(afterAbort.output.trim()).toBe("unset");
	});
	it("streams output chunks", async () => {
		const chunks: string[] = [];
		const result = await executeBash("i=1; while [ $i -le 20 ]; do echo line$i; i=$((i+1)); done", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				expect(chunk.length).toBeGreaterThan(0);
				chunks.push(chunk);
			},
		});
		// At least one chunk should have been delivered to onChunk
		expect(chunks.length).toBeGreaterThan(0);
		const combined = chunks.join("");
		expect(combined).toContain("line1");
		// Final result always has the complete output regardless of chunk throttle
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line20");
	});

	it("streams large output without exhausting memory", async () => {
		if (process.platform === "win32") {
			return;
		}
		let sawChunk = false;
		const result = await executeBash("awk 'BEGIN { for (i = 0; i < 100000; i++) printf \"a\" }'", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: () => {
				sawChunk = true;
			},
		});
		expect(sawChunk).toBe(true);
		expect(result.totalBytes).toBe(100000);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).toContain("a");
	});

	it("handles multi-million line output without freeze or OOM", async () => {
		if (process.platform === "win32") return;

		// 5 million lines ~= 40MB of output. Before the 64KB read buffer and
		// direct-push fixes, this would freeze or OOM the process.
		const lineCount = 5_000_000;
		let chunkCount = 0;
		const start = Date.now();
		const result = await executeBash(`seq 1 ${lineCount}`, {
			cwd: tempDir,
			timeout: 30_000,
			onChunk: () => {
				chunkCount++;
			},
		});
		const elapsed = Date.now() - start;

		// Should complete, not hang or OOM
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);

		// Output summary should reflect all lines
		expect(result.totalLines).toBeGreaterThanOrEqual(lineCount);

		// Truncated output should be within the spill threshold
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);

		// The tail should still contain numeric values near the end of the range.
		// BSD `seq` on macOS formats large numbers in scientific notation, so parse
		// the final lines numerically instead of matching one exact decimal string.
		const tailValues = result.output
			.split("\n")
			.slice(-1000)
			.map(line => Number(line.trim()))
			.filter(Number.isFinite);
		expect(tailValues.some(value => value >= lineCount - 500 && value <= lineCount)).toBe(true);

		// With 64KB read buffer, ~40MB should produce ~600 chunks, not 5M.
		// Allow generous headroom but ensure it's orders of magnitude below lineCount.
		expect(chunkCount).toBeLessThan(lineCount / 100);

		// Should complete in reasonable time (not frozen). On a modern machine
		// seq 1 5000000 itself takes ~0.5s; with JS overhead allow 20s.
		expect(elapsed).toBeLessThan(20_000);
	}, 35_000);

	it("sources snapshot env vars across session commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);
		const sessionKey = "snapshot-test";
		await executeBash("true", { cwd: tempDir, timeout: 5000, sessionKey });
		const result = await executeBash("echo $PI_SNAPSHOT_TEST", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(result.output.trim()).toBe("from_snapshot");
	});

	it("sources large bash functions without base64 eval wrappers", async () => {
		if (process.platform === "win32") {
			return;
		}
		const realBashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(realBashPath)) {
			return;
		}

		const bashPath = path.join(tempDir, "test-bash");
		fs.symlinkSync(realBashPath, bashPath);
		const largeBody = Array.from({ length: 200 }, (_, index) => `    echo "snapshot ${index}"`).join("\n");
		fs.writeFileSync(path.join(tempDir, ".bashrc"), `pi_snapshot_large_function ()\n{\n${largeBody}\n}\n`);

		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		const snapshotPath = await shellSnapshot.getOrCreateSnapshot(bashPath, {
			PATH: Bun.env.PATH ?? "",
			HOME: tempDir,
		});
		expect(snapshotPath).not.toBeNull();
		const snapshot = fs.readFileSync(snapshotPath!, "utf8");
		expect(snapshot).toContain("pi_snapshot_large_function");
		expect(snapshot).not.toContain("base64 -d");

		const result = await executeBash("printf 'snapshot_ok\\n'", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "large-function-snapshot",
		});
		expect(result.cancelled).toBe(false);
		expect(result.output.trim()).toBe("snapshot_ok");
	});

	it("does not allow exec to replace the host", async () => {
		const result = await executeBash("exec echo hi", { cwd: tempDir, timeout: 5000 });
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).not.toBeUndefined();
		if (!result.output.includes("hi")) {
			expect(result.output.toLowerCase()).toContain("exec");
		}
	});

	it("completes even when background job keeps stdout pipe open", async () => {
		if (process.platform === "win32") return;

		const runPromise = executeBash("{ sleep 3; echo late; } & echo immediate", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(1500).then(() => ({ type: "timeout" as const })),
		]);

		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.cancelled).toBe(false);
			expect(timed.result.exitCode).toBe(0);
			expect(timed.result.output).toContain("immediate");
		}
	});
	it("kills spawned process on timeout (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");

		// Command creates marker after 2s, but we timeout after 100ms
		const result = await executeBash(`sleep 2 && echo done > ${marker}`, {
			cwd: tempDir,
			timeout: 100,
		});

		expect(result.cancelled).toBe(true);

		// Wait longer than the command would have taken
		await Bun.sleep(3000);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on timeout", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		const result = await executeBash(`{ sleep 2; echo done > '${markerEscaped}'; } & sleep 10`, {
			cwd: tempDir,
			timeout: 100,
		});

		expect(result.cancelled).toBe(true);

		await Bun.sleep(3000);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on abort", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg-abort.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		const promise = executeBash(`{ sleep 2; echo done > '${markerEscaped}'; } & sleep 10`, {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);

		await Bun.sleep(3000);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills spawned process on abort (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const controller = new AbortController();

		// Command creates marker after 2s
		const promise = executeBash(`sleep 2 && echo done > ${marker}`, {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		// Abort after 100ms
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);

		// Wait longer than the command would have taken
		await Bun.sleep(3000);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});
});
