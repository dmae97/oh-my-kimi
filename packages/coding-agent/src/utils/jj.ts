import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LRUCache } from "lru-cache/raw";

/** Result from a completed `jj` subprocess invocation. */
export interface JjCommandResult {
	/** Process exit code reported by `jj`. */
	exitCode: number;
	/** Captured standard output as UTF-8 text. */
	stdout: string;
	/** Captured standard error as UTF-8 text. */
	stderr: string;
}

/** Options for `jj diff --git` invocations. */
export interface DiffOptions {
	/** Optional file paths to restrict the diff with `-- <files>`. */
	readonly files?: readonly string[];
	/** Optional abort signal passed to the spawned `jj` process. */
	readonly signal?: AbortSignal;
}

interface CommandOptions {
	readonly signal?: AbortSignal;
}

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
	const result = await jj(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new JjCommandError(args, result);
	}
	return result;
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff", "--git"];
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

const WORKSPACE_ROOT_CACHE_MAX_ENTRIES = 256;
const workspaceRootCache = new LRUCache<string, string | null>({ max: WORKSPACE_ROOT_CACHE_MAX_ENTRIES });

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
	if (workspaceRootCache.has(key)) return workspaceRootCache.get(key) ?? undefined;

	for (let dir: string | undefined = key; dir; dir = parentOf(dir)) {
		if (await hasJjWorkspaceMetadata(dir)) {
			workspaceRootCache.set(key, dir);
			return dir;
		}
	}

	workspaceRootCache.set(key, null);
	return undefined;
}

/** Clear cached workspace roots. Intended for tests that mutate JJ metadata under an existing path. */
export function clearWorkspaceRootCache(): void {
	workspaceRootCache.clear();
}

/** Resolve the current Jujutsu workspace root, or `undefined` when `cwd` is not in a JJ repository. */
export async function workspaceRoot(cwd: string): Promise<string | undefined> {
	return findWorkspaceRoot(cwd);
}

/** Return whether `cwd` is inside a Jujutsu repository. */
export async function isRepository(cwd: string): Promise<boolean> {
	return (await workspaceRoot(cwd)) !== undefined;
}

/** Run `jj diff --git` for the current workspace commit and return the raw Git-format diff text. */
export async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
	return (await runChecked(cwd, buildDiffArgs(options), { signal: options.signal })).stdout;
}
