/**
 * Subprocess spawn-option helpers for the Python kernel.
 *
 * Lives in its own file (separate from `kernel.ts`) so the predicate can be
 * unit-tested without dragging in the kernel's runtime dependencies.
 */

/**
 * Whether the Python kernel subprocess should be spawned with `windowsHide: true`.
 *
 * On Windows, Bun maps `windowsHide: true` to the `CREATE_NO_WINDOW` flag, which
 * detaches the child from any inherited console. The Python kernel runs user code
 * that imports NumPy/pandas; those native extensions (`numpy/_core/_multiarray_umath.pyd`
 * + bundled OpenBLAS/SLEEF thread-pool init) can deadlock inside `LoadLibraryExW`
 * when no console is attached, and a console-less child cannot receive SIGINT via
 * `GenerateConsoleCtrlEvent` (the recovery path the host relies on). See #1960.
 *
 * So on Windows we hide only when the host itself has no console to share
 * (service / piped-launch mode). In an interactive TTY launch the kernel
 * inherits the parent's console — analogous to `python.exe` invoked from
 * `cmd.exe` — which keeps native imports and SIGINT recovery working.
 *
 * Short-lived helper subprocesses elsewhere in the codebase (LSP probes, git,
 * plugin installs) keep `windowsHide: true` because they don't load complex
 * native modules and the brief console flash would be user-visible noise.
 */
export function shouldHideKernelWindow(opts: { platform: NodeJS.Platform; stdoutIsTTY: boolean }): boolean {
	if (opts.platform !== "win32") return false;
	return !opts.stdoutIsTTY;
}
