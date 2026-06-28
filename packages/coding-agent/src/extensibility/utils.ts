import * as path from "node:path";
import { theme } from "../modes/theme/theme";
import { expandPath, normalizeLocalScheme } from "../tools/path-utils";
import type { HookUIContext } from "./hooks/types";

/**
 * Resolve a file path:
 * - Absolute paths used as-is
 * - Paths starting with ~ expanded to home directory
 * - Relative paths resolved from cwd
 */
export function resolvePath(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expanded);
	if (expandedAndNormalized.startsWith("local://")) {
		throw new Error(
			`Path "${filePath}" uses internal scheme "local://" and must be resolved through the proper protocol handler, not as a filesystem path.`,
		);
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

/**
 * Create a no-op UI context for headless modes.
 */
export function createNoOpUIContext(): HookUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setStatus: () => {},
		custom: async () => undefined as never,
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		get theme() {
			return theme;
		},
	};
}

/**
 * Raised by {@link withExitGuard} when a guarded callback synchronously
 * attempts to terminate the host process. Callers catch this like any other
 * import-time failure so the extension/hook is skipped with a logged error
 * instead of taking the CLI down with it.
 */
export class ExtensionExitError extends Error {
	readonly code: number | string | undefined;
	constructor(code: number | string | undefined) {
		super(
			`Module called process.exit(${code === undefined ? "" : String(code)}) at import time; ` +
				`OMP extension/hook modules must not terminate the host process.`,
		);
		this.name = "ExtensionExitError";
		this.code = code;
	}
}

let exitGuardDepth = 0;
let exitGuardOriginal: typeof process.exit | null = null;

/**
 * Run `fn` with `process.exit` patched so any synchronous attempt to terminate
 * the host raises {@link ExtensionExitError} instead. Restored in `finally`.
 *
 * Guards the dynamic-import sites that load third-party extension / hook
 * modules — a top-level `process.exit(0)` in a stranger's script (e.g. a
 * Codex hook script that happens to live next to OMP-shaped modules) would
 * otherwise kill OMP during startup with no error surface, since `try/catch`
 * around `await import()` cannot intercept a synchronous exit.
 *
 * Nested and concurrent guard windows are safe: only the outermost guard
 * restores the real `process.exit`.
 */
export async function withExitGuard<T>(fn: () => Promise<T>): Promise<T> {
	if (exitGuardDepth === 0) {
		exitGuardOriginal = process.exit;
		process.exit = ((code?: number | string): never => {
			throw new ExtensionExitError(code);
		}) as typeof process.exit;
	}
	exitGuardDepth++;
	try {
		return await fn();
	} finally {
		exitGuardDepth--;
		if (exitGuardDepth === 0 && exitGuardOriginal) {
			process.exit = exitGuardOriginal;
			exitGuardOriginal = null;
		}
	}
}
