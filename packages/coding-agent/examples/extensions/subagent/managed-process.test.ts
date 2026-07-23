import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runManagedProcess } from "./managed-process.ts";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hanging-process-tree.mjs");

async function processExists(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(pid, 0);
			await new Promise((resolve) => setTimeout(resolve, 25));
		} catch {
			return false;
		}
	}
	return true;
}

describe("managed subagent process lifecycle", () => {
	it("escalates a cutoff from SIGTERM to SIGKILL and reaps the process tree", async () => {
		let stdout = "";
		const result = await runManagedProcess({
			command: process.execPath,
			args: [fixturePath],
			cwd: process.cwd(),
			// Generous cutoff: the fixture is a fresh `node` process that needs
			// ~50-100ms+ (more under parallel load) to start and write its stdout
			// handshake before the cutoff may fire, otherwise stdout is empty.
			cutoffMs: 2_500,
			terminationGraceMs: 40,
			forceSettleMs: 1_000,
			onStdout: (chunk) => {
				stdout += chunk;
			},
		});
		const event = JSON.parse(stdout.trim()) as { grandchildPid: number };

		expect(result.reason).toBe("cutoff");
		expect(result.cleanup.termSent).toBe(true);
		expect(result.cleanup.killSent).toBe(true);
		expect(result.elapsedMs).toBeLessThan(8_000);
		expect(await processExists(result.pid)).toBe(false);
		if (process.platform !== "win32") {
			expect(await processExists(event.grandchildPid)).toBe(false);
		}
	});

	it("kills resistant descendants even when the direct child exits on SIGTERM", async () => {
		let stdout = "";
		const result = await runManagedProcess({
			command: process.execPath,
			args: [fixturePath, "--parent-exits"],
			cwd: process.cwd(),
			// Generous cutoff so the fixture's stdout handshake lands before the
			// cutoff fires (see note above).
			cutoffMs: 2_500,
			terminationGraceMs: 500,
			forceSettleMs: 1_000,
			onStdout: (chunk) => {
				stdout += chunk;
			},
		});
		const event = JSON.parse(stdout.trim()) as { grandchildPid: number };

		expect(result.reason).toBe("cutoff");
		expect(result.cleanup).toMatchObject({ termSent: true, killSent: true });
		if (process.platform !== "win32") {
			expect(await processExists(event.grandchildPid)).toBe(false);
		}
	});

	it.skipIf(process.platform === "win32")("reaps resistant descendants left by a normally exiting child", async () => {
		let stdout = "";
		const result = await runManagedProcess({
			command: process.execPath,
			args: [fixturePath, "--normal-orphan"],
			cwd: process.cwd(),
			cutoffMs: 4_000,
			// Wider grace gives the orphaned, SIGTERM-resistant grandchild a stable
			// window so the process-group existence check (and SIGKILL escalation)
			// is deterministic under parallel load.
			terminationGraceMs: 300,
			forceSettleMs: 500,
			onStdout: (chunk) => {
				stdout += chunk;
			},
		});
		const event = JSON.parse(stdout.trim()) as { grandchildPid: number };
		try {
			expect(result).toMatchObject({
				exitCode: 0,
				reason: "completed",
				cleanup: { termSent: true, killSent: true, processGroup: true },
			});
			expect(await processExists(event.grandchildPid)).toBe(false);
		} finally {
			try {
				process.kill(event.grandchildPid, "SIGKILL");
			} catch {
				// Expected when managed cleanup reaped the descendant.
			}
		}
	});

	it("distinguishes parent cancellation from an internal cutoff", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("caller canceled")), 40);
		const result = await runManagedProcess({
			command: process.execPath,
			args: [fixturePath],
			cwd: process.cwd(),
			cutoffMs: 5_000,
			terminationGraceMs: 20,
			forceSettleMs: 1_000,
			signal: controller.signal,
		});

		expect(result.reason).toBe("aborted");
		expect(result.cleanup.termSent).toBe(true);
	});

	it("returns typed spawn failures instead of rejecting past cleanup boundaries", async () => {
		const result = await runManagedProcess({
			command: "missing",
			args: [],
			cwd: process.cwd(),
			cutoffMs: 1_000,
			spawnProcess: () => {
				throw new Error("fixture spawn failure");
			},
		});

		expect(result).toMatchObject({
			pid: -1,
			exitCode: 1,
			reason: "spawn-error",
			errorMessage: "fixture spawn failure",
		});
	});

	it("does not spawn when the parent signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already canceled"));
		let spawned = false;
		const result = await runManagedProcess({
			command: process.execPath,
			args: [fixturePath],
			cwd: process.cwd(),
			cutoffMs: 1_000,
			signal: controller.signal,
			spawnProcess: () => {
				spawned = true;
				throw new Error("must not spawn");
			},
		});

		expect(spawned).toBe(false);
		expect(result).toMatchObject({ pid: -1, exitCode: 130, reason: "aborted" });
	});

	it("leaves a normally completed process untouched", async () => {
		let stdout = "";
		const result = await runManagedProcess({
			command: process.execPath,
			args: ["-e", "process.stdout.write('done')"],
			cwd: process.cwd(),
			cutoffMs: 1_000,
			onStdout: (chunk) => {
				stdout += chunk;
			},
		});

		expect(result).toMatchObject({ reason: "completed", exitCode: 0 });
		expect(result.cleanup).toEqual({ termSent: false, killSent: false, processGroup: process.platform !== "win32" });
		expect(stdout).toBe("done");
	});
});
