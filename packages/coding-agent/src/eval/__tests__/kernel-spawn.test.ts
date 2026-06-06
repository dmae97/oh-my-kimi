import { describe, expect, it } from "bun:test";
import { shouldHideKernelWindow } from "../py/spawn-options";

/**
 * `shouldHideKernelWindow` decides whether the long-lived Python kernel
 * subprocess is spawned with `windowsHide: true`. On Windows, Bun maps that
 * option to `CREATE_NO_WINDOW`, which detaches the child from any inherited
 * console — breaking both (a) `LoadLibraryExW` for NumPy/pandas native
 * extensions and (b) SIGINT delivery via `GenerateConsoleCtrlEvent`. See
 * issue #1960. Tests cover each axis of that decision plus the partial-stdio-
 * redirection regression flagged in PR #1961 review.
 */
describe("shouldHideKernelWindow", () => {
	it("inherits the host console on Windows when stdout is a TTY", () => {
		// The reporter's path: omp launched in Windows Terminal, all stdio
		// attached to the console. Kernel must inherit so `import pandas`
		// doesn't deadlock in `_multiarray_umath` and SIGINT can recover.
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: true })).toBe(false);
	});

	it("hides on Windows only when the host has no console at all (service / daemon)", () => {
		// True service launches have neither stdin, stdout, nor stderr on a
		// terminal — there's no console to inherit. CREATE_NO_WINDOW here
		// avoids Windows auto-allocating an invisible console for the kernel.
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: false })).toBe(true);
	});

	it("never sets windowsHide off-Windows (the option is a Win32-only flag)", () => {
		// On POSIX, `windowsHide` is a Bun no-op; we keep the predicate
		// returning false everywhere off-Windows so the spawn site matches
		// pre-fix behavior on Linux/macOS regardless of TTY state.
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: false })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: false })).toBe(false);
	});

	describe("hostHasInheritableConsole computation contract (per PR #1961 review)", () => {
		// The call site passes `process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY`
		// — any TTY on the host means it still owns a console. Below replays
		// the realistic shell scenarios that motivated widening the check
		// beyond stdout-only.
		const compute = (stdin: boolean, stdout: boolean, stderr: boolean): boolean => stdin || stdout || stderr;

		it("treats a fully interactive launch (all three TTY) as console-attached", () => {
			// `omp` in Windows Terminal: stdin/stdout/stderr all on the
			// console. Predicate must NOT hide → kernel inherits, no #1960 hang.
			expect(
				shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: compute(true, true, true) }),
			).toBe(false);
		});

		it("treats `omp -p '...' > out.txt` (stdout redirected only) as console-attached", () => {
			// The reviewer's repro: a single redirect drops stdout's TTY flag,
			// but stdin and stderr are still on the console. Previously the
			// stdout-only check would have hidden here and re-introduced the
			// import hang; now the OR keeps the console attached.
			expect(
				shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: compute(true, false, true) }),
			).toBe(false);
		});

		it("treats stdin-piped launches as console-attached (stderr still on console)", () => {
			// `omp ... < in.txt`: only stdin loses TTY, stderr (commonly used
			// for diagnostics) keeps the console attached to the host.
			expect(
				shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: compute(false, true, true) }),
			).toBe(false);
		});

		it("treats `2>err.log` only as console-attached", () => {
			// Equivalent symmetric case: stderr alone redirected.
			expect(
				shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: compute(true, true, false) }),
			).toBe(false);
		});

		it("only hides when none of stdin/stdout/stderr is a TTY", () => {
			// Fully detached: service mode, daemon, or `< in > out 2> err`
			// piped at every stream. No console exists to inherit, so the
			// child gets CREATE_NO_WINDOW to keep Windows from auto-allocating
			// one for the console-app Python kernel.
			expect(
				shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: compute(false, false, false) }),
			).toBe(true);
		});
	});
});
