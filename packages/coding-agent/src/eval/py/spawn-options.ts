/**
 * Subprocess spawn-option helpers for the Python kernel.
 *
 * Pure helpers (`shouldHideKernelWindow`, `consoleAttachedViaTTY`) live here
 * so they can be unit-tested without dragging in the kernel's runtime
 * dependencies. The effectful `hostHasInheritableConsole` wraps a Win32 FFI
 * probe with a TTY fallback and is the function `kernel.ts` actually calls.
 */
import { dlopen, FFIType } from "bun:ffi";

/**
 * Decide whether the long-lived Python kernel subprocess should be spawned
 * with `windowsHide: true`.
 *
 * On Windows, Bun maps `windowsHide: true` to the `CREATE_NO_WINDOW` flag,
 * which detaches the child from any inherited console. The Python kernel
 * runs user code that imports NumPy/pandas; those native extensions
 * (`numpy/_core/_multiarray_umath.pyd` + bundled OpenBLAS/SLEEF thread-pool
 * init) can deadlock inside `LoadLibraryExW` when no console is attached,
 * and a console-less child cannot receive SIGINT via
 * `GenerateConsoleCtrlEvent` (the recovery path the host relies on). See
 * issue #1960.
 *
 * So on Windows we hide only when the host itself has no console to share.
 * In any launch where a console is attached — even one with every stdio
 * stream redirected — the kernel inherits the parent's console, matching
 * `python.exe` invoked from `cmd.exe`, which keeps native imports and
 * SIGINT recovery working.
 *
 * Short-lived helper subprocesses elsewhere in the codebase (LSP probes,
 * git, plugin installs) keep `windowsHide: true` because they don't load
 * complex native modules and the brief console flash would be user-visible
 * noise.
 */
export function shouldHideKernelWindow(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
}): boolean {
	if (opts.platform !== "win32") return false;
	return !opts.hostHasInheritableConsole;
}

/**
 * TTY-based fallback used when the Win32 console probe is unavailable.
 *
 * Returns `true` if any of stdin/stdout/stderr is currently a TTY. This
 * correctly detects the common interactive launches and the partial-
 * redirection cases (`omp -p > out.txt`, `< in.txt`, `2> err.log`) where at
 * least one stream stays bound to the terminal. The all-stdio-redirected
 * case (`< in > out 2> err` from a console) is the reason we prefer the
 * Win32 probe over this fallback whenever possible.
 */
export function consoleAttachedViaTTY(opts: {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	stderrIsTTY: boolean;
}): boolean {
	return opts.stdinIsTTY || opts.stdoutIsTTY || opts.stderrIsTTY;
}

/**
 * Probe `kernel32.dll!GetConsoleWindow()` to detect whether the current
 * Windows process owns a console window.
 *
 * Returns `true` for a non-NULL HWND, `false` when NULL (no console — true
 * service / `DETACHED_PROCESS` / GUI parent), and `null` when the probe
 * itself fails (off-Windows, FFI disabled, or unexpected kernel32 layout).
 * A `null` return means "don't trust me, use the TTY fallback".
 *
 * Cached on first call because in practice the console attachment of a
 * long-lived OMP host never changes for the lifetime of the process, and
 * we don't want to re-dlopen kernel32 on every kernel spawn.
 */
type ConsoleProbeResult = boolean | null;
let cachedWindowsConsoleProbe: { value: ConsoleProbeResult } | undefined;

function probeWindowsConsoleWindow(): ConsoleProbeResult {
	if (cachedWindowsConsoleProbe) return cachedWindowsConsoleProbe.value;
	let value: ConsoleProbeResult = null;
	try {
		const lib = dlopen("kernel32.dll", {
			GetConsoleWindow: { args: [], returns: FFIType.ptr },
		});
		try {
			const hwnd = lib.symbols.GetConsoleWindow();
			// FFIType.ptr returns `Pointer | null`; a 0 pointer should also be
			// treated as NULL defensively in case Bun ever returns 0n / 0.
			value = hwnd !== null && hwnd !== 0;
		} finally {
			lib.close();
		}
	} catch {
		value = null;
	}
	cachedWindowsConsoleProbe = { value };
	return value;
}

/** Reset the cached Win32 probe result. Test-only; not part of the public surface. */
export function __resetWindowsConsoleProbeCache(): void {
	cachedWindowsConsoleProbe = undefined;
}

/**
 * Whether the host process owns a console its children can inherit.
 *
 * - On Windows, the authoritative signal is `GetConsoleWindow()`. It returns
 *   a non-NULL HWND whenever the process has a console attached, regardless
 *   of how the standard streams are redirected — so an `omp -p ... < in.txt
 *   > out.txt 2> err.log` launched from a real Windows Terminal session is
 *   correctly classified as console-attached and the kernel keeps its
 *   inheritable console.
 * - On any other platform, or if the FFI probe fails, fall back to the
 *   TTY-OR heuristic. That still catches the common interactive cases.
 */
export function hostHasInheritableConsole(): boolean {
	if (process.platform === "win32") {
		const native = probeWindowsConsoleWindow();
		if (native !== null) return native;
	}
	return consoleAttachedViaTTY({
		stdinIsTTY: !!process.stdin.isTTY,
		stdoutIsTTY: !!process.stdout.isTTY,
		stderrIsTTY: !!process.stderr.isTTY,
	});
}
