import type { ExtensionAPI } from "../extensibility/extensions";
import * as git from "../utils/git";
import { isAutoresearchLocalStatePath, normalizeAutoresearchPath } from "./helpers";

const AUTORESEARCH_BRANCH_PREFIX = "autoresearch/";
const BRANCH_NAME_MAX_LENGTH = 48;

export interface EnsureAutoresearchBranchFailure {
	error: string;
	ok: false;
}

export interface EnsureAutoresearchBranchSuccess {
	branchName: string;
	created: boolean;
	ok: true;
}

export type EnsureAutoresearchBranchResult = EnsureAutoresearchBranchFailure | EnsureAutoresearchBranchSuccess;

export async function getCurrentAutoresearchBranch(_api: ExtensionAPI, workDir: string): Promise<string | null> {
	const currentBranch = (await git.branch.current(workDir)) ?? "";
	return currentBranch.startsWith(AUTORESEARCH_BRANCH_PREFIX) ? currentBranch : null;
}

export async function ensureAutoresearchBranch(
	api: ExtensionAPI,
	workDir: string,
	goal: string | null,
): Promise<EnsureAutoresearchBranchResult> {
	const repoRoot = await git.repo.root(workDir);
	if (!repoRoot) {
		return {
			error: "Autoresearch requires a git repository so it can isolate experiments and revert failed runs safely.",
			ok: false,
		};
	}

	let dirtyPathsOutput: string;
	try {
		dirtyPathsOutput = await git.status(repoRoot, {
			porcelainV1: true,
			untrackedFiles: "all",
			z: true,
		});
	} catch (err) {
		return {
			error: `Unable to inspect git status before starting autoresearch: ${err instanceof Error ? err.message : String(err)}`,
			ok: false,
		};
	}

	const workDirPrefix = await readGitWorkDirPrefix(api, workDir);
	const unsafeDirtyPaths = collectUnsafeDirtyPaths(dirtyPathsOutput, workDirPrefix);
	const currentBranch = await getCurrentAutoresearchBranch(api, workDir);
	if (currentBranch) {
		if (unsafeDirtyPaths.length > 0) {
			return buildUnsafeDirtyPathsFailure(unsafeDirtyPaths);
		}
		return {
			branchName: currentBranch,
			created: false,
			ok: true,
		};
	}
	if (unsafeDirtyPaths.length > 0) {
		return buildUnsafeDirtyPathsFailure(unsafeDirtyPaths);
	}

	const branchName = await allocateBranchName(api, workDir, goal);
	try {
		await git.branch.checkoutNew(workDir, branchName);
	} catch (err) {
		return {
			error: `Failed to create autoresearch branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
			ok: false,
		};
	}

	return {
		branchName,
		created: true,
		ok: true,
	};
}

export function parseWorkDirDirtyPaths(statusOutput: string, workDirPrefix: string): string[] {
	const relativePaths: string[] = [];
	for (const dirtyPath of parseDirtyPaths(statusOutput)) {
		const relativePath = relativizeGitPathToWorkDir(dirtyPath, workDirPrefix);
		if (relativePath === null) continue;
		relativePaths.push(relativePath);
	}
	return relativePaths;
}

export function relativizeGitPathToWorkDir(repoRelativePath: string, workDirPrefix: string): string | null {
	const normalizedPath = normalizeStatusPath(repoRelativePath);
	const normalizedPrefix = normalizeAutoresearchPath(workDirPrefix);
	if (normalizedPrefix === "" || normalizedPrefix === ".") {
		return normalizedPath;
	}
	if (normalizedPath === normalizedPrefix) {
		return ".";
	}
	if (!normalizedPath.startsWith(`${normalizedPrefix}/`)) {
		return null;
	}
	return normalizeAutoresearchPath(normalizedPath.slice(normalizedPrefix.length + 1));
}

async function readGitWorkDirPrefix(api: ExtensionAPI, workDir: string): Promise<string> {
	void api;
	try {
		return await git.show.prefix(workDir);
	} catch {
		return "";
	}
}

export function parseDirtyPaths(statusOutput: string): string[] {
	if (statusOutput.includes("\0")) {
		return parseDirtyPathsNul(statusOutput);
	}
	return parseDirtyPathsLines(statusOutput);
}

function parseDirtyPathsNul(statusOutput: string): string[] {
	const unsafePaths = new Set<string>();
	let index = 0;
	while (index + 3 <= statusOutput.length) {
		const statusToken = statusOutput.slice(index, index + 3);
		index += 3;
		const pathEnd = statusOutput.indexOf("\0", index);
		if (pathEnd < 0) break;
		const firstPath = statusOutput.slice(index, pathEnd);
		index = pathEnd + 1;
		addDirtyPath(unsafePaths, firstPath);
		if (isRenameOrCopy(statusToken)) {
			const secondPathEnd = statusOutput.indexOf("\0", index);
			if (secondPathEnd < 0) break;
			const secondPath = statusOutput.slice(index, secondPathEnd);
			index = secondPathEnd + 1;
			addDirtyPath(unsafePaths, secondPath);
		}
	}
	return [...unsafePaths];
}

function parseDirtyPathsLines(statusOutput: string): string[] {
	const unsafePaths = new Set<string>();
	for (const line of statusOutput.split("\n")) {
		const trimmedLine = line.trimEnd();
		if (trimmedLine.length < 4) continue;
		const rawPath = trimmedLine.slice(3).trim();
		if (rawPath.length === 0) continue;
		const renameParts = rawPath.split(" -> ");
		for (const renamePart of renameParts) {
			addDirtyPath(unsafePaths, renamePart);
		}
	}
	return [...unsafePaths];
}

export function normalizeStatusPath(path: string): string {
	let normalized = path.trim();
	if (normalized.startsWith('"') && normalized.endsWith('"')) {
		normalized = normalized.slice(1, -1);
	}
	return normalizeAutoresearchPath(normalized);
}

async function allocateBranchName(api: ExtensionAPI, workDir: string, goal: string | null): Promise<string> {
	const baseName = `${AUTORESEARCH_BRANCH_PREFIX}${slugifyGoal(goal)}-${currentDateStamp()}`;
	let candidate = baseName;
	let suffix = 2;
	while (await branchExists(api, workDir, candidate)) {
		candidate = `${baseName}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}

async function branchExists(api: ExtensionAPI, workDir: string, branchName: string): Promise<boolean> {
	void api;
	return git.ref.exists(workDir, `refs/heads/${branchName}`);
}

function slugifyGoal(goal: string | null): string {
	const normalized = (goal ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const trimmed = normalized.slice(0, BRANCH_NAME_MAX_LENGTH).replace(/-+$/g, "");
	return trimmed || "session";
}

function currentDateStamp(): string {
	const now = new Date();
	const year = String(now.getFullYear());
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

function addDirtyPath(paths: Set<string>, rawPath: string): void {
	const normalizedPath = normalizeStatusPath(rawPath);
	if (normalizedPath.length === 0) return;
	paths.add(normalizedPath);
}

function buildUnsafeDirtyPathsFailure(unsafeDirtyPaths: string[]): EnsureAutoresearchBranchFailure {
	const preview = unsafeDirtyPaths.slice(0, 5).join(", ");
	const suffix = unsafeDirtyPaths.length > 5 ? ` (+${unsafeDirtyPaths.length - 5} more)` : "";
	return {
		error:
			"Autoresearch needs a clean git worktree before it can create or reuse an isolated branch. " +
			`Commit or stash these paths first: ${preview}${suffix}`,
		ok: false,
	};
}

function isRenameOrCopy(statusToken: string): boolean {
	const trimmed = statusToken.trim();
	return trimmed.startsWith("R") || trimmed.startsWith("C");
}

function collectUnsafeDirtyPaths(statusOutput: string, workDirPrefix: string): string[] {
	const unsafeDirtyPaths: string[] = [];
	for (const dirtyPath of parseDirtyPaths(statusOutput)) {
		const relativePath = relativizeGitPathToWorkDir(dirtyPath, workDirPrefix);
		if (relativePath && isAutoresearchLocalStatePath(relativePath)) {
			continue;
		}
		unsafeDirtyPaths.push(relativePath ?? normalizeStatusPath(dirtyPath));
	}
	return unsafeDirtyPaths;
}

export interface DirtyPathEntry {
	path: string;
	untracked: boolean;
}

export function parseDirtyPathsWithStatus(statusOutput: string): DirtyPathEntry[] {
	if (statusOutput.includes("\0")) {
		return parseDirtyPathsNulWithStatus(statusOutput);
	}
	return parseDirtyPathsLinesWithStatus(statusOutput);
}

function parseDirtyPathsNulWithStatus(statusOutput: string): DirtyPathEntry[] {
	const seen = new Set<string>();
	const results: DirtyPathEntry[] = [];
	let index = 0;
	while (index + 3 <= statusOutput.length) {
		const statusToken = statusOutput.slice(index, index + 3);
		index += 3;
		const pathEnd = statusOutput.indexOf("\0", index);
		if (pathEnd < 0) break;
		const firstPath = statusOutput.slice(index, pathEnd);
		index = pathEnd + 1;
		const untracked = statusToken.trim().startsWith("??");
		addDirtyPathEntry(seen, results, firstPath, untracked);
		if (isRenameOrCopy(statusToken)) {
			const secondPathEnd = statusOutput.indexOf("\0", index);
			if (secondPathEnd < 0) break;
			const secondPath = statusOutput.slice(index, secondPathEnd);
			index = secondPathEnd + 1;
			addDirtyPathEntry(seen, results, secondPath, false);
		}
	}
	return results;
}

function parseDirtyPathsLinesWithStatus(statusOutput: string): DirtyPathEntry[] {
	const seen = new Set<string>();
	const results: DirtyPathEntry[] = [];
	for (const line of statusOutput.split("\n")) {
		const trimmedLine = line.trimEnd();
		if (trimmedLine.length < 4) continue;
		const statusToken = trimmedLine.slice(0, 3);
		const rawPath = trimmedLine.slice(3).trim();
		if (rawPath.length === 0) continue;
		const untracked = statusToken.trim().startsWith("??");
		const renameParts = rawPath.split(" -> ");
		for (const renamePart of renameParts) {
			addDirtyPathEntry(seen, results, renamePart, untracked);
		}
	}
	return results;
}

function addDirtyPathEntry(seen: Set<string>, results: DirtyPathEntry[], rawPath: string, untracked: boolean): void {
	const normalizedPath = normalizeStatusPath(rawPath);
	if (normalizedPath.length === 0 || seen.has(normalizedPath)) return;
	seen.add(normalizedPath);
	results.push({ path: normalizedPath, untracked });
}

export function parseWorkDirDirtyPathsWithStatus(statusOutput: string, workDirPrefix: string): DirtyPathEntry[] {
	const results: DirtyPathEntry[] = [];
	for (const entry of parseDirtyPathsWithStatus(statusOutput)) {
		const relativePath = relativizeGitPathToWorkDir(entry.path, workDirPrefix);
		if (relativePath === null) continue;
		results.push({ path: relativePath, untracked: entry.untracked });
	}
	return results;
}

export function computeRunModifiedPaths(
	preRunDirtyPaths: string[],
	currentStatusOutput: string,
	workDirPrefix: string,
): { tracked: string[]; untracked: string[] } {
	const preRunSet = new Set(preRunDirtyPaths);
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (const entry of parseWorkDirDirtyPathsWithStatus(currentStatusOutput, workDirPrefix)) {
		if (preRunSet.has(entry.path)) continue;
		if (isAutoresearchLocalStatePath(entry.path)) continue;
		if (entry.untracked) {
			untracked.push(entry.path);
		} else {
			tracked.push(entry.path);
		}
	}
	return { tracked, untracked };
}
