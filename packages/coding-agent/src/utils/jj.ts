import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { LRUCache } from "lru-cache/raw";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Result from a completed `jj` subprocess invocation. */
export interface JjCommandResult {
	/** Process exit code reported by `jj`. */
	exitCode: number;
	/** Captured standard output as UTF-8 text. */
	stdout: string;
	/** Captured standard error as UTF-8 text. */
	stderr: string;
}

/** Resolved Jujutsu workspace metadata. */
export interface JjRepository {
	/** Root directory containing the `.jj` workspace metadata. */
	repoRoot: string;
	/** Path to the workspace store directory used to verify a real JJ checkout. */
	storeDir: string;
}

/** Options for `jj diff` invocations. */
export interface DiffOptions {
	/** Optional file paths to restrict the diff with `-- <files>`. */
	readonly files?: readonly string[];
	/** Return only changed file names instead of Git-format diff text. */
	readonly nameOnly?: boolean;
	/** Optional abort signal passed to the spawned `jj` process. */
	readonly signal?: AbortSignal;
}

interface CommandOptions {
	readonly signal?: AbortSignal;
}

// ════════════════════════════════════════════════════════════════════════════
// Error
// ════════════════════════════════════════════════════════════════════════════

/** Error thrown when a checked `jj` command exits non-zero. */
export class JjCommandError extends Error {
	/** Arguments passed after the common `jj --no-pager --color=never` prefix. */
	readonly args: readonly string[];
	/** Captured command result that caused the failure. */
	readonly result: JjCommandResult;

	/** Create an error for a failed checked `jj` command. */
	constructor(args: readonly string[], result: JjCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "JjCommandError";
		this.args = [...args];
		this.result = result;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Core execution
// ════════════════════════════════════════════════════════════════════════════

function ensureAvailable(): void {
	if (!$which("jj")) {
		throw new Error("jj is not installed.");
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<JjCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `jj ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function jj(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<JjCommandResult> {
	const child = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
		cwd,
		signal: options.signal,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture jj command output.");
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { exitCode: exitCode ?? 0, stdout, stderr };
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<JjCommandResult> {
	ensureAvailable();
	const result = await jj(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new JjCommandError(args, result);
	}
	return result;
}

async function runText(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	args.push(options.nameOnly ? "--name-only" : "--git");
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Repository resolution
// ════════════════════════════════════════════════════════════════════════════

interface WorkspaceRootCacheEntry {
	readonly root?: string;
}

const WORKSPACE_ROOT_CACHE_MAX_ENTRIES = 256;
const workspaceRootCache = new LRUCache<string, WorkspaceRootCacheEntry>({ max: WORKSPACE_ROOT_CACHE_MAX_ENTRIES });

async function hasJjWorkspaceMetadata(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(path.join(dir, ".jj", "repo", "store"))).isDirectory();
	} catch {
		return false;
	}
}

function parentOf(dir: string): string | undefined {
	const parent = path.dirname(dir);
	return parent === dir ? undefined : parent;
}

async function findWorkspaceRoot(cwd: string): Promise<string | undefined> {
	const key = path.resolve(cwd);
	if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)?.root;

	for (let dir: string | undefined = key; dir; dir = parentOf(dir)) {
		if (await hasJjWorkspaceMetadata(dir)) {
			workspaceRootCache.set(key, { root: dir });
			return dir;
		}
	}

	workspaceRootCache.set(key, {});
	return undefined;
}

function repositoryFromRoot(root: string): JjRepository {
	return {
		repoRoot: root,
		storeDir: path.join(root, ".jj", "repo", "store"),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// API: diff
// ════════════════════════════════════════════════════════════════════════════

/** Run `jj diff --git` for the current workspace commit and return the raw Git-format diff text. */
export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		return runText(cwd, buildDiffArgs(options), { signal: options.signal });
	},
	{
		/** List changed file paths. */
		async changedFiles(cwd: string, options: Pick<DiffOptions, "files" | "signal"> = {}): Promise<string[]> {
			return splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},
	},
);

// ════════════════════════════════════════════════════════════════════════════
// API: repo
// ════════════════════════════════════════════════════════════════════════════

export const repo = {
	/** Clear cached workspace roots. Intended for tests that mutate JJ metadata under an existing path. */
	clearRootCache(): void {
		workspaceRootCache.clear();
	},

	/** Resolve the current Jujutsu workspace root, or `null` when `cwd` is not in a JJ repository. */
	async root(cwd: string): Promise<string | null> {
		return (await findWorkspaceRoot(cwd)) ?? null;
	},

	/** Full Jujutsu workspace metadata. */
	async resolve(cwd: string): Promise<JjRepository | null> {
		const root = await repo.root(cwd);
		return root ? repositoryFromRoot(root) : null;
	},

	/** Check whether `cwd` is inside a Jujutsu repository. */
	async is(cwd: string): Promise<boolean> {
		return (await repo.root(cwd)) !== null;
	},
};
