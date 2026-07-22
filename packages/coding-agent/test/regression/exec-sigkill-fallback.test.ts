import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";

// Hosts may have a locale configured that is not installed (e.g. LC_ALL=ko_KR.UTF-8),
// which makes spawned shells print a setlocale warning on stderr. Pin LC_ALL to the
// always-available C locale for this file so shell output stays deterministic.
const savedLcAll = process.env.LC_ALL;
beforeAll(() => {
	process.env.LC_ALL = "C";
});
afterAll(() => {
	if (savedLcAll === undefined) delete process.env.LC_ALL;
	else process.env.LC_ALL = savedLcAll;
});

// trap/SIGTERM semantics are POSIX-only.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("execCommand SIGKILL fallback (regression)", () => {
	it("resolves promptly for a process that exits on its own", async () => {
		const result = await execCommand("bash", ["-c", "echo hi"], process.cwd());
		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
		expect(result.stdout.trim()).toBe("hi");
	});

	it("terminates a SIGTERM-responsive process at the timeout without waiting for the force-kill window", async () => {
		const start = performance.now();
		const result = await execCommand("sleep", ["30"], process.cwd(), { timeout: 200 });
		expect(result.killed).toBe(true);
		expect(performance.now() - start).toBeLessThan(3000);
	});

	it("escalates to SIGKILL when the process traps SIGTERM, so the timeout still terminates it", async () => {
		// Before the fix, the fallback checked `if (!proc.killed)` — but ChildProcess.killed
		// becomes true as soon as SIGTERM is successfully SENT, so the SIGKILL escalation
		// never fired and this promise hung until `sleep 30` finished (or forever for a
		// process that never exits), defeating both timeout and abort.
		const start = performance.now();
		const result = await execCommand("bash", ["-c", 'trap "" TERM; sleep 30'], process.cwd(), {
			timeout: 200,
		});
		const elapsed = performance.now() - start;
		expect(result.killed).toBe(true);
		// timeout (200ms) + force-kill fallback window (5s) + settle grace — far below `sleep 30`.
		expect(elapsed).toBeGreaterThanOrEqual(5000);
		expect(elapsed).toBeLessThan(15000);
	}, 25000);
});
