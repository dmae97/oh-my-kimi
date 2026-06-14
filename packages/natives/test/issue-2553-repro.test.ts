/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/2553.
 *
 * Linux source builds hung while requiring the `.node` because the module
 * initializer spawned probe threads before Bun finished loading the addon.
 * The exposed contract is simple: importing the package must return promptly
 * and emit the loader's completion marker when startup debugging is enabled.
 */
import { describe, expect, it } from "bun:test";

const LOAD_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol("timed out");

describe("issue 2553: linux source-built native load", () => {
	it("returns from package import instead of hanging in addon initialization", async () => {
		const proc = Bun.spawn([process.execPath, "-e", "import '@oh-my-pi/pi-natives'; console.log('ok natives');"], {
			cwd: pathFromRepoRoot(),
			env: { ...process.env, PI_DEBUG_STARTUP: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});

		// Real timeout is the contract here: a broken native load never resolves.
		const outcome = await Promise.race([proc.exited, Bun.sleep(LOAD_TIMEOUT_MS).then(() => TIMED_OUT)]);
		if (outcome === TIMED_OUT) {
			proc.kill("SIGKILL");
		}

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

		expect(outcome).not.toBe(TIMED_OUT);
		expect(outcome).toBe(0);
		expect(stderr).toContain("[startup] native:loadNative:done");
		expect(stdout).toBe("ok natives\n");
	});
});

function pathFromRepoRoot(): string {
	return new URL("../../..", import.meta.url).pathname;
}
