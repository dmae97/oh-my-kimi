import { describe, expect, it } from "bun:test";
import { shouldHideKernelWindow } from "../py/spawn-options";

/**
 * `shouldHideKernelWindow` decides whether the long-lived Python kernel
 * subprocess is spawned with `windowsHide: true`. On Windows, Bun maps that
 * option to `CREATE_NO_WINDOW`, which detaches the child from any inherited
 * console — breaking both (a) `LoadLibraryExW` for NumPy/pandas native
 * extensions and (b) SIGINT delivery via `GenerateConsoleCtrlEvent`. See
 * issue #1960. The tests below defend each axis of that decision.
 */
describe("shouldHideKernelWindow", () => {
	it("inherits the parent console on Windows when the host has a TTY (interactive)", () => {
		// The reporter's repro path: omp launched in Windows Terminal, parent
		// has a console, kernel must inherit it so `import pandas` doesn't
		// deadlock in `_multiarray_umath` and SIGINT can recover the cell.
		expect(shouldHideKernelWindow({ platform: "win32", stdoutIsTTY: true })).toBe(false);
	});

	it("hides on Windows when the host has no TTY (service / piped launch)", () => {
		// Fallback for non-interactive launches where there's no console to
		// share anyway. Setting CREATE_NO_WINDOW here avoids Windows
		// auto-allocating an invisible console for the kernel.
		expect(shouldHideKernelWindow({ platform: "win32", stdoutIsTTY: false })).toBe(true);
	});

	it("never sets windowsHide off-Windows (the option is a Win32-only flag)", () => {
		// The flag exists only on Windows; on POSIX `windowsHide` is a no-op
		// in Bun, so returning false on every non-win32 input keeps the spawn
		// site identical to the pre-fix behavior on Linux/macOS.
		expect(shouldHideKernelWindow({ platform: "linux", stdoutIsTTY: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "linux", stdoutIsTTY: false })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", stdoutIsTTY: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", stdoutIsTTY: false })).toBe(false);
	});
});
