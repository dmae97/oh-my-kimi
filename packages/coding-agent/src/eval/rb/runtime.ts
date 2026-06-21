/**
 * Ruby runtime resolution utilities.
 *
 * Resolves the Ruby interpreter for the local kernel and filters the
 * environment to a safe allowlist before exposing it to user cell code. Much
 * simpler than the Python sibling — Ruby has no venv layout to detect — but it
 * mirrors the same allowlist/denylist + explicit-interpreter shape.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

const DEFAULT_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
];

const WINDOWS_ENV_ALLOWLIST = [
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
];

const DEFAULT_ENV_DENYLIST = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
];

// Ruby version managers and gem layout live behind these prefixes; passing them
// through lets `bundle`/`gem`/rbenv/asdf-shimmed code resolve consistently.
const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_", "GEM_", "BUNDLE", "RBENV_", "RUBY", "CHRUBY_", "ASDF_"];

const CASE_INSENSITIVE_ENV = process.platform === "win32";

// Dynamic-membership lookups: built once by normalizing the static lists, then
// queried with `.has()` against runtime env keys.
const NORMALIZED_ALLOWLIST = new Set(
	[...DEFAULT_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST].map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_DENYLIST = new Set(DEFAULT_ENV_DENYLIST.map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)));
const NORMALIZED_ALLOW_PREFIXES = CASE_INSENSITIVE_ENV
	? DEFAULT_ENV_ALLOW_PREFIXES.map(prefix => prefix.toUpperCase())
	: DEFAULT_ENV_ALLOW_PREFIXES;

// Secret-shaped names that must never leak into eval cells even when they fall
// under a broad allow-prefix (e.g. `RUBYGEMS_API_KEY` under `RUBY`). Checked
// after the explicit allowlist so intentional entries (SSH_AUTH_SOCK) survive.
const SECRET_KEY_PATTERN = /API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY/i;

export interface RubyRuntime {
	/** Path to the ruby executable. */
	rubyPath: string;
	/** Filtered environment variables. */
	env: Record<string, string | undefined>;
}

/**
 * Filter environment variables to a safe allowlist for Ruby subprocesses.
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
 * Resolve an explicitly configured interpreter (`ruby.interpreter`) into a
 * runtime, bypassing discovery. Does not probe the executable — callers must
 * check it actually runs. `~` expands to the home directory and relative paths
 * resolve against `cwd`.
 */
export function resolveExplicitRubyRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): RubyRuntime {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	const rubyPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	return { rubyPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Ruby runtimes in priority order. With an explicit
 * interpreter that is the only candidate; otherwise the first `ruby` on PATH.
 */
export function enumerateRubyRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RubyRuntime[] {
	if (interpreter) {
		return [resolveExplicitRubyRuntime(interpreter, cwd, baseEnv)];
	}
	const systemPath = $which("ruby");
	return systemPath ? [{ rubyPath: systemPath, env: { ...baseEnv } }] : [];
}

/**
 * Resolve the highest-priority Ruby runtime. Throws when none exists.
 */
export function resolveRubyRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RubyRuntime {
	const [runtime] = enumerateRubyRuntimes(cwd, baseEnv, interpreter);
	if (!runtime) {
		throw new Error("Ruby executable not found on PATH");
	}
	return runtime;
}
