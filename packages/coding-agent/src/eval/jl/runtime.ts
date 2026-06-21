/**
 * Julia runtime resolution utilities.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

const DEFAULT_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"USERNAME",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LANG",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"DISPLAY",
	"XAUTHORITY",
	"TZ",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
];

const WINDOWS_ENV_ALLOWLIST = [
	"ALLUSERSPROFILE",
	"APPDATA",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"COMPUTERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"PUBLIC",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"USERDOMAIN",
	"USERDOMAIN_ROAMING_PC",
	"USERPROFILE",
];

const DEFAULT_ENV_DENYLIST = ["PI_API_KEY", "PI_TOKEN", "PI_PASSWORD", "PI_SESSION", "PI_TOOL_BRIDGE_TOKEN"];

// Julia version managers and package layout live behind these prefixes; passing them
// through lets Julia discover packages and configure its runtime consistently.
const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_", "JULIA_", "OPENBLAS_", "MKL_"];

const CASE_INSENSITIVE_ENV = process.platform === "win32";

const NORMALIZED_ALLOWLIST = new Set(
	[...DEFAULT_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST].map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_DENYLIST = new Set(DEFAULT_ENV_DENYLIST.map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)));
const NORMALIZED_ALLOW_PREFIXES = CASE_INSENSITIVE_ENV
	? DEFAULT_ENV_ALLOW_PREFIXES.map(prefix => prefix.toUpperCase())
	: DEFAULT_ENV_ALLOW_PREFIXES;

// Secret-shaped names that must never leak into eval cells even when they fall
// under a broad allow-prefix.
const SECRET_KEY_PATTERN = /API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY/i;

export interface JuliaRuntime {
	/** Path to the julia executable. */
	juliaPath: string;
	/** Filtered environment variables. */
	env: Record<string, string | undefined>;
}

/**
 * Filter environment variables to a safe allowlist for Julia subprocesses.
 * Removes sensitive API keys and limits to known-safe variables.
 */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const key in env) {
		const value = env[key];
		if (value === undefined) continue;
		const normalizedKey = CASE_INSENSITIVE_ENV ? key.toUpperCase() : key;
		if (NORMALIZED_DENYLIST.has(normalizedKey)) continue;
		if (NORMALIZED_ALLOWLIST.has(normalizedKey)) {
			filtered[normalizedKey === "PATH" ? "PATH" : key] = value;
			continue;
		}
		if (SECRET_KEY_PATTERN.test(normalizedKey)) continue;
		if (NORMALIZED_ALLOW_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Resolve an explicitly configured interpreter (`julia.interpreter`) into a
 * runtime, bypassing discovery. Does not probe the executable.
 * `~` expands to the home directory and relative paths resolve against `cwd`.
 */
export function resolveExplicitJuliaRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): JuliaRuntime {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	const juliaPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	return { juliaPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Julia runtimes in priority order. With an explicit
 * interpreter that is the only candidate; otherwise the first `julia` on PATH.
 */
export function enumerateJuliaRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime[] {
	if (interpreter) {
		return [resolveExplicitJuliaRuntime(interpreter, cwd, baseEnv)];
	}
	const systemPath = $which("julia");
	return systemPath ? [{ juliaPath: systemPath, env: { ...baseEnv } }] : [];
}

/**
 * Resolve the highest-priority Julia runtime. Throws when none exists.
 */
export function resolveJuliaRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime {
	const [runtime] = enumerateJuliaRuntimes(cwd, baseEnv, interpreter);
	if (!runtime) {
		throw new Error("Julia executable not found on PATH");
	}
	return runtime;
}
