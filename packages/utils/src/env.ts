import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir } from "./dirs";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (!isSafeEnvName(key) || value === undefined || !isSafeEnvValue(value)) continue;
		result[key] = value;
	}
	return result;
}

/**
 * Parses a .env file synchronously and extracts key-value string pairs.
 * Ignores lines that are empty or start with '#'. Trims whitespace.
 * Allows values to be quoted with single or double quotes.
 * Returns an object of key-value pairs.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			// Skip comments and blank lines
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			if (!isValidEnvName(key)) continue;

			let value = trimmed.slice(eqIndex + 1).trim();

			// Remove surrounding quotes (" or ')
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;

			result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
	for (const key in file) {
		if (!Bun.env[key]) {
			Bun.env[key] = file[key];
		}
	}
}

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@oh-my-pi/pi-utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, NaN, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

/** True when `BUN_ENV` or `NODE_ENV` is the string `test`. */
export function isBunTestRuntime(): boolean {
	return Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `PI_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (process.env.PI_COMPILED || Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

/**
 * Main-module path declared by self-dispatching CLI entrypoints — entries
 * whose top-level argv handling routes hidden `__omp_*` worker selectors.
 * Worker spawn sites re-enter this module via `new Worker(entry, { argv })`,
 * so every distribution (source, npm bundle, compiled binary) needs exactly
 * one JavaScript entrypoint. Never set under `bun test`, SDK embedding, or
 * standalone package bins — those hosts load worker modules directly.
 */
let workerHostMain: string | null = null;

/** Called by CLI entrypoints whose main module dispatches worker argv selectors. */
export function declareWorkerHostEntry(): void {
	workerHostMain = Bun.main;
}

/** Main-module path of the self-dispatching CLI host, or null outside it. */
export function workerHostEntry(): string | null {
	return workerHostMain;
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
export function $flag(name: string, def: boolean = false): boolean {
	const value = $env[name];
	if (!value) return def;
	return TRUTHY[value] === true;
}
