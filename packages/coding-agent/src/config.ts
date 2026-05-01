import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getConfigAgentDirName,
	getProjectDir,
	isEnoent,
	logger,
} from "@oh-my-pi/pi-utils";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ErrorObject } from "ajv";
import { JSONC, YAML } from "bun";
import { expandTilde } from "./tools/path-utils";

const priorityList = [
	{ dir: CONFIG_DIR_NAME, globalAgentDir: getConfigAgentDirName },
	{ dir: ".claude" },
	{ dir: ".codex" },
	{ dir: ".gemini" },
];

// =============================================================================
// Package Directory (for optional external docs/examples)
// =============================================================================

/**
 * Get the base directory for resolving optional package assets (docs, examples).
 * Walk up from import.meta.dir until we find package.json, or fall back to cwd.
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return expandTilde(envDir);
	}

	let dir = import.meta.dir;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	// Fallback to project dir (docs/examples won't be found, but that's fine)
	return getProjectDir();
}

/** Get path to CHANGELOG.md (optional, may not exist in binary) */
export function getChangelogPath(): string {
	return path.resolve(path.join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// User Config Paths (~/.omp/agent/*)
// =============================================================================

function migrateJsonToYml(jsonPath: string, ymlPath: string) {
	try {
		if (fs.existsSync(ymlPath)) return;
		if (!fs.existsSync(jsonPath)) return;

		const content = fs.readFileSync(jsonPath, "utf-8");
		const parsed = JSON.parse(content);
		if (!parsed) {
			logger.warn("migrateJsonToYml: invalid json structure", { path: jsonPath });
			return;
		}
		fs.writeFileSync(ymlPath, YAML.stringify(parsed, null, 2));
	} catch (error) {
		logger.warn("migrateJsonToYml: migration failed", { error: String(error) });
	}
}

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: TSchema;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

export class ConfigError extends Error {
	readonly #message: string;
	constructor(
		public readonly id: string,
		public readonly schemaErrors: ErrorObject[] | null | undefined,
		public readonly other?: { err: unknown; stage: string },
	) {
		let messages: string[] | undefined;
		let cause: any | undefined;
		let klass: string;

		if (schemaErrors) {
			klass = "Schema";
			messages = schemaErrors.map(e => `${e.instancePath || "root"}: ${e.message}`);
		} else if (other) {
			klass = other.stage;
			if (other.err instanceof Error) {
				messages = [other.err.message];
				cause = other.err;
			} else {
				messages = [String(other.err)];
			}
		} else {
			klass = "Unknown";
		}

		const title = `Failed to load config file ${id}, ${klass} error:`;
		let message: string;
		switch (messages?.length ?? 0) {
			case 0:
				message = title.slice(0, -1);
				break;
			case 1:
				message = `${title} ${messages![0]}`;
				break;
			default:
				message = `${title}\n${messages!.map(m => `  - ${m}`).join("\n")}`;
				break;
		}

		super(message, { cause });
		this.name = "LoadError";
		this.#message = message;
	}

	get message(): string {
		return this.#message;
	}

	toString(): string {
		return this.message;
	}
}

export type LoadStatus = "ok" | "error" | "not-found";

export type LoadResult<T> =
	| { value?: null; error: ConfigError; status: "error" }
	| { value: T; error?: undefined; status: "ok" }
	| { value?: null; error?: unknown; status: "not-found" };

export class ConfigFile<T> implements IConfigFile<T> {
	readonly #basePath: string;
	#cache?: LoadResult<T>;
	#auxValidate?: (value: T) => void;

	constructor(
		readonly id: string,
		readonly schema: TSchema,
		configPath: string = path.join(getAgentDir(), `${id}.yml`),
	) {
		this.#basePath = configPath;
		if (configPath.endsWith(".yml")) {
			const jsonPath = `${configPath.slice(0, -4)}.json`;
			migrateJsonToYml(jsonPath, configPath);
		} else if (configPath.endsWith(".yaml")) {
			const jsonPath = `${configPath.slice(0, -5)}.json`;
			migrateJsonToYml(jsonPath, configPath);
		} else if (configPath.endsWith(".json") || configPath.endsWith(".jsonc")) {
			// JSON configs are still supported without migration.
		} else {
			throw new Error(`Invalid config file path: ${configPath}`);
		}
	}

	relocate(path?: string): ConfigFile<T> {
		if (!path || path === this.#basePath) return this;
		const result = new ConfigFile<T>(this.id, this.schema, path);
		result.#auxValidate = this.#auxValidate;
		return result;
	}

	getMtimeMs(): number | null {
		try {
			return fs.statSync(this.path()).mtimeMs;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	withValidation(name: string, validate: (value: T) => void): this {
		const prev = this.#auxValidate;
		this.#auxValidate = (value: T) => {
			prev?.(value);
			try {
				validate(value);
			} catch (error) {
				throw new ConfigError(this.id, undefined, { err: error, stage: `Validate(${name})` });
			}
		};
		return this;
	}

	createDefault() {
		return Value.Default(this.schema, [], undefined) as T;
	}

	#storeCache(result: LoadResult<T>): LoadResult<T> {
		this.#cache = result;
		return result;
	}

	tryLoad(): LoadResult<T> {
		if (this.#cache) return this.#cache;

		try {
			const content = fs.readFileSync(this.path(), "utf-8").trim();

			let parsed: unknown;
			if (this.#basePath.endsWith(".json") || this.#basePath.endsWith(".jsonc")) {
				parsed = JSONC.parse(content);
			} else if (this.#basePath.endsWith(".yml") || this.#basePath.endsWith(".yaml")) {
				parsed = YAML.parse(content);
			} else {
				throw new Error(`Invalid config file path: ${this.#basePath}`);
			}

			if (!Value.Check(this.schema, parsed)) {
				const schemaErrors: ErrorObject[] = [];
				for (const err of Value.Errors(this.schema, parsed)) {
					schemaErrors.push({ instancePath: err.path, message: err.message } as ErrorObject);
					if (schemaErrors.length >= 50) break;
				}
				const error = new ConfigError(this.id, schemaErrors);
				logger.warn("Failed to parse config file", { path: this.path(), error });
				return this.#storeCache({ error, status: "error" });
			}
			return this.#storeCache({ value: parsed as T, status: "ok" });
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to parse config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Unexpected" }),
				status: "error",
			});
		}
	}

	load(): T | null {
		return this.tryLoad().value ?? null;
	}

	loadOrDefault(): T {
		return this.tryLoad().value ?? this.createDefault();
	}

	path(): string {
		return this.#basePath;
	}

	invalidate() {
		this.#cache = undefined;
	}
}

// =============================================================================
// Multi-Config Directory Helpers
// =============================================================================

/**
 * Config directory bases in priority order (highest first).
 * User-level: ~/.omp/agent, ~/.claude, ~/.codex, ~/.gemini
 * Project-level: .omp, .claude, .codex, .gemini
 */
const USER_CONFIG_BASES = priorityList.map(({ dir, globalAgentDir }) => ({
	base: () => path.join(os.homedir(), globalAgentDir ? globalAgentDir() : dir),
	name: dir,
}));

const PROJECT_CONFIG_BASES = priorityList.map(({ dir }) => ({
	base: dir,
	name: dir,
}));

export interface ConfigDirEntry {
	path: string;
	source: string; // e.g., ".omp", ".claude"
	level: "user" | "project";
}

export interface GetConfigDirsOptions {
	/** Include user-level directories (~/.omp/agent/...). Default: true */
	user?: boolean;
	/** Include project-level directories (.omp/...). Default: true */
	project?: boolean;
	/** Current working directory for project paths. Default: getProjectDir() */
	cwd?: string;
	/** Only return directories that exist. Default: false */
	existingOnly?: boolean;
}

/**
 * Get all config directories for a subpath, ordered by priority (highest first).
 *
 * @param subpath - Subpath within config dirs (e.g., "commands", "hooks", "agents")
 * @param options - Options for filtering
 * @returns Array of directory entries, highest priority first
 *
 * @example
 * // Get all command directories
 * getConfigDirs("commands")
 * // → [{ path: "~/.omp/agent/commands", source: ".omp", level: "user" }, ...]
 *
 * @example
 * // Get only existing project skill directories
 * getConfigDirs("skills", { user: false, existingOnly: true })
 */
export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = getProjectDir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	// User-level directories (highest priority)
	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			const resolvedPath = path.resolve(base(), subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "user" });
			}
		}
	}

	// Project-level directories
	if (project) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const resolvedPath = path.resolve(cwd, base, subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "project" });
			}
		}
	}

	return results;
}

/**
 * Get all config directory paths for a subpath (convenience wrapper).
 * Returns just the paths, highest priority first.
 */
export function getConfigDirPaths(subpath: string, options: GetConfigDirsOptions = {}): string[] {
	return getConfigDirs(subpath, options).map(e => e.path);
}

export interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

/**
 * Find the first existing config file (for non-JSON files like SYSTEM.md).
 * Returns just the path, or undefined if not found.
 */
export function findConfigFile(subpath: string, options: GetConfigDirsOptions = {}): string | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return filePath;
		}
	}

	return undefined;
}

/**
 * Find the first existing config file with metadata.
 */
export function findConfigFileWithMeta(
	subpath: string,
	options: GetConfigDirsOptions = {},
): Omit<ConfigFileResult<never>, "content"> | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base, source, level } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return { path: filePath, source, level };
		}
	}

	return undefined;
}

// =============================================================================
// Walk-Up Config Discovery (for monorepo scenarios)
// =============================================================================

/**
 * Find all nearest config directories by walking up from cwd.
 * Returns one entry per config base (.omp, .claude) - the nearest one found.
 * Results are in priority order (highest first).
 */
export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = getProjectDir()): ConfigDirEntry[] {
	const results: ConfigDirEntry[] = [];
	const foundBases = new Set<string>();

	let currentDir = cwd;

	while (foundBases.size < PROJECT_CONFIG_BASES.length) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			if (foundBases.has(name)) continue;

			const candidate = path.join(currentDir, base, subpath);
			try {
				if (fs.statSync(candidate).isDirectory()) {
					results.push({ path: candidate, source: name, level: "project" });
					foundBases.add(name);
				}
			} catch {}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Sort by priority order
	const order = PROJECT_CONFIG_BASES.map(b => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
