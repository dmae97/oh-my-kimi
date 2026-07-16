/**
 * Repro for https://github.com/can1357/oh-my-pi/issues/4812
 *
 * A long-lived omp session that survives an in-place `bun install -g` upgrade
 * keeps the previous pi-natives NAPI addon resident in the process. A tab
 * worker spawned afterwards runs the freshly-installed JS loader, which expects
 * the new sentinel (e.g. `__piNativesV16_3_11`), but `require` returns the
 * resident old exports carrying the PRIOR sentinel (`__piNativesV16_3_10`).
 *
 * The contract this test pins down: `validateLoadedBindings` distinguishes a
 * process-stale mix (disk consistent — restart to re-sync) from a genuinely
 * disk-stale addon (reinstall to re-sync), and never tells the operator to
 * reinstall when the bindings already carry a versioned sentinel.
 */
import { describe, expect, it } from "bun:test";
import { validateLoadedBindings } from "../native/loader-state.js";

const candidate = "/home/u/.bun/install/global/node_modules/@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64.node";

function ctxFor(version: string) {
	return {
		isWorkspaceLoad: false,
		packageVersion: version,
		versionSentinelExport: `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`,
	};
}

describe("issue 4812: pi-natives sentinel process-stale diagnosis", () => {
	it("accepts bindings that expose the expected sentinel", () => {
		const ctx = ctxFor("16.3.11");
		expect(() =>
			validateLoadedBindings(ctx, { __piNativesV16_3_11: () => {}, grep: () => {} }, candidate),
		).not.toThrow();
	});

	it("reports a mid-session upgrade (restart) when bindings carry an older sentinel", () => {
		const ctx = ctxFor("16.3.11");
		const resident = { __piNativesV16_3_10: () => {}, grep: () => {} };
		let message = "";
		try {
			validateLoadedBindings(ctx, resident, candidate);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("16.3.10");
		expect(message).toContain("restart omp");
		expect(message).toContain("Disk is already consistent");
		// The disk-stale advice must NOT appear for a process-stale mix.
		expect(message).not.toContain("reinstall to re-sync");
		expect(message).not.toContain("from a different release than this loader");
	});

	it("still reports disk-stale (reinstall) when no versioned sentinel is present", () => {
		const ctx = ctxFor("16.3.11");
		const stale = { grep: () => {}, astGrep: () => {} };
		let message = "";
		try {
			validateLoadedBindings(ctx, stale, candidate);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("from a different release than this loader");
		expect(message).toContain("reinstall to re-sync");
		expect(message).not.toContain("restart omp");
	});

	it("skips validation entirely in workspace dev", () => {
		const ctx = { ...ctxFor("16.3.11"), isWorkspaceLoad: true };
		expect(() => validateLoadedBindings(ctx, { grep: () => {} }, candidate)).not.toThrow();
	});
});
