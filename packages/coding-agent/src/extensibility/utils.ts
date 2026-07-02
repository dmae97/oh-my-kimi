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
 * load-time failure so the extension/hook is skipped with a logged error
 * instead of taking the CLI down with it.
 */
export class ExtensionExitError extends Error {
	readonly code: number | string | undefined;
	constructor(
		code: number | string | undefined,
		readonly alias = "process.exit",
	) {
		super(
			`Module called ${alias}(${code === undefined ? "" : String(code)}) during guarded extension/hook loading; ` +
				`OMP extension/hook modules must not terminate the host process.`,
		);
		this.name = "ExtensionExitError";
		this.code = code;
	}
}

type ExitAliasName = "process.exit" | "process.reallyExit";

let exitGuardDepth = 0;
let exitGuardOriginalProcessExit: typeof process.exit | null = null;
let exitGuardOriginalReallyExit: typeof process.reallyExit | null = null;

/**
 * Run `fn` with hard-exit APIs patched so any synchronous attempt to terminate
 * the host raises {@link ExtensionExitError} instead. Restored in `finally`.
 *
 * Guards the dynamic-import and factory-invocation sites that load third-party
 * extension / hook modules — a `process.exit(0)` or `process.reallyExit(0)` in
 * a stranger's script (e.g. a Codex hook script that happens to live next to
 * OMP-shaped modules) would otherwise kill OMP during startup with no error
 * surface, since `try/catch` cannot intercept a synchronous exit.
 *
 * Nested and concurrent guard windows are safe: only the outermost guard
 * restores the real hard-exit APIs.
 */
function guardedExit(alias: ExitAliasName): (code?: number | string) => never {
	return (code?: number | string): never => {
		throw new ExtensionExitError(code, alias);
	};
}

export async function withExitGuard<T>(fn: () => Promise<T>): Promise<T> {
	if (exitGuardDepth === 0) {
		exitGuardOriginalProcessExit = process.exit;
		process.exit = guardedExit("process.exit") as typeof process.exit;

		if (typeof process.reallyExit === "function") {
			exitGuardOriginalReallyExit = process.reallyExit;
			process.reallyExit = guardedExit("process.reallyExit") as typeof process.reallyExit;
		}
	}
	exitGuardDepth++;
	try {
		return await fn();
	} finally {
		exitGuardDepth--;
		if (exitGuardDepth === 0) {
			if (exitGuardOriginalProcessExit) {
				process.exit = exitGuardOriginalProcessExit;
				exitGuardOriginalProcessExit = null;
			}
			if (exitGuardOriginalReallyExit) {
				process.reallyExit = exitGuardOriginalReallyExit;
				exitGuardOriginalReallyExit = null;
			}
		}
	}
}
