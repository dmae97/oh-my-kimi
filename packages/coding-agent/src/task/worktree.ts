import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projfsOverlayStart, projfsOverlayStop } from "@oh-my-pi/pi-natives";
import { $which, getWorktreeDir, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import * as git from "../utils/git";

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export function getEncodedProjectName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) {
		throw new Error("Git repository not found for isolated task execution.");
	}

	return repoRoot;
}

const PROJFS_UNAVAILABLE_PREFIX = "PROJFS_UNAVAILABLE:";
const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function isProjfsUnavailableError(err: unknown): boolean {
	return err instanceof Error && err.message.includes(PROJFS_UNAVAILABLE_PREFIX);
}

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

export async function ensureWorktree(baseCwd: string, id: string): Promise<string> {
	const repoRoot = await getRepoRoot(baseCwd);
	const encodedProject = getEncodedProjectName(repoRoot);
	const worktreeDir = getWorktreeDir(encodedProject, id);
	await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
	await git.worktree.tryRemove(repoRoot, worktreeDir);
	await fs.rm(worktreeDir, { recursive: true, force: true });
	await git.worktree.add(repoRoot, worktreeDir, "HEAD", { detach: true });
	return worktreeDir;
}

/** Find nested git repositories (non-submodule) under the given root. */
async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	// Get submodule paths so we can exclude them
	const submodulePaths = new Set(await git.ls.submodules(repoRoot));

	// Find all .git dirs/files that aren't the root or known submodules
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);
			// Check if this directory is itself a git repo
			const gitDir = path.join(full, ".git");
			let hasGit = false;
			try {
				await fs.access(gitDir);
				hasGit = true;
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
				result.push(rel);
				// Don't recurse into nested repos — they manage their own tree
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const headCommit = (await git.head.sha(repoRoot)) ?? "";
	const staged = await git.diff(repoRoot, { binary: true, cached: true });
	const unstaged = await git.diff(repoRoot, { binary: true });
	const untracked = await git.ls.untracked(repoRoot);
	return { repoRoot, headCommit, staged, unstaged, untracked };
}

export async function captureBaseline(repoRoot: string): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([captureRepoBaseline(repoRoot), discoverNestedRepos(repoRoot)]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath)),
		})),
	);
	return { root, nested };
}

async function applyRepoBaseline(worktreeDir: string, rb: RepoBaseline, sourceRoot: string): Promise<void> {
	await git.patch.applyText(worktreeDir, rb.staged, { cached: true });
	await git.patch.applyText(worktreeDir, rb.staged);
	await git.patch.applyText(worktreeDir, rb.unstaged);

	for (const entry of rb.untracked) {
		const source = path.join(sourceRoot, entry);
		const destination = path.join(worktreeDir, entry);
		try {
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.cp(source, destination, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
}

export async function applyBaseline(worktreeDir: string, baseline: WorktreeBaseline): Promise<void> {
	await applyRepoBaseline(worktreeDir, baseline.root, baseline.root.repoRoot);

	// Restore nested repos into the worktree
	for (const entry of baseline.nested) {
		const nestedDir = path.join(worktreeDir, entry.relativePath);
		// Copy the nested repo wholesale (it's not managed by root git)
		const sourceDir = path.join(baseline.root.repoRoot, entry.relativePath);
		try {
			await fs.cp(sourceDir, nestedDir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		// Apply any uncommitted changes from the nested baseline
		await applyRepoBaseline(nestedDir, entry.baseline, entry.baseline.repoRoot);
		// Commit baseline state so captureRepoDeltaPatch can cleanly subtract it.
		// Without this, `git add -A && git commit` by the task would include
		// baseline untracked files in the diff-tree output.
		if ((await git.status(nestedDir)).trim().length > 0) {
			await git.stage.files(nestedDir);
			await git.commit(nestedDir, "omp-baseline", { allowEmpty: true });
			// Update baseline to reflect the committed state — prevents double-apply
			// in captureRepoDeltaPatch's temp-index path
			entry.baseline.headCommit = (await git.head.sha(nestedDir)) ?? "";
			entry.baseline.staged = "";
			entry.baseline.unstaged = "";
			entry.baseline.untracked = [];
		}
	}
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline): Promise<string> {
	// Check if HEAD advanced (task committed changes)
	const currentHead = (await git.head.sha(repoDir)) ?? "";
	const headAdvanced = currentHead && currentHead !== rb.headCommit;

	if (headAdvanced) {
		// HEAD moved: use diff-tree to capture committed changes, plus any uncommitted on top
		const parts: string[] = [];

		// Committed changes since baseline
		const committedDiff = await git.diff.tree(repoDir, rb.headCommit, currentHead, {
			allowFailure: true,
			binary: true,
		});
		if (committedDiff.trim()) parts.push(committedDiff);

		// Uncommitted changes on top of the new HEAD
		const staged = await git.diff(repoDir, { binary: true, cached: true });
		const unstaged = await git.diff(repoDir, { binary: true });
		if (staged.trim()) parts.push(staged);
		if (unstaged.trim()) parts.push(unstaged);

		// New untracked files (relative to both baseline and current tracking)
		const currentUntracked = await git.ls.untracked(repoDir);
		const baselineUntracked = new Set(rb.untracked);
		const newUntracked = currentUntracked.filter(entry => !baselineUntracked.has(entry));
		if (newUntracked.length > 0) {
			const nullPath = getGitNoIndexNullPath();
			const untrackedDiffs = await Promise.all(
				newUntracked.map(entry =>
					git.diff(repoDir, {
						allowFailure: true,
						binary: true,
						noIndex: { left: nullPath, right: entry },
					}),
				),
			);
			parts.push(...untrackedDiffs.filter(d => d.trim()));
		}

		return parts.join("\n");
	}

	// HEAD unchanged: use temp index approach (subtracts baseline from delta)
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	try {
		await git.readTree(repoDir, rb.headCommit, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
		await git.patch.applyText(repoDir, rb.staged, {
			cached: true,
			env: { GIT_INDEX_FILE: tempIndex },
		});
		await git.patch.applyText(repoDir, rb.unstaged, {
			cached: true,
			env: { GIT_INDEX_FILE: tempIndex },
		});
		const diff = await git.diff(repoDir, {
			binary: true,
			env: { GIT_INDEX_FILE: tempIndex },
		});

		const currentUntracked = await git.ls.untracked(repoDir);
		const baselineUntracked = new Set(rb.untracked);
		const newUntracked = currentUntracked.filter(entry => !baselineUntracked.has(entry));

		if (newUntracked.length === 0) return diff;

		const nullPath = getGitNoIndexNullPath();
		const untrackedDiffs = await Promise.all(
			newUntracked.map(entry =>
				git.diff(repoDir, {
					allowFailure: true,
					binary: true,
					noIndex: { left: nullPath, right: entry },
				}),
			),
		);
		return `${diff}${diff && !diff.endsWith("\n") ? "\n" : ""}${untrackedDiffs.join("\n")}`;
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

/**
 * Apply nested repo patches directly to their working directories after parent merge.
 * @param commitMessage Optional async function to generate a commit message from the combined diff.
 *                      If omitted or returns null, falls back to a generic message.
 */
export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<void> {
	// Group patches by target repo to apply all at once and commit
	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const p of patches) {
		if (!p.patch.trim()) continue;
		const group = byRepo.get(p.relativePath) ?? [];
		group.push(p);
		byRepo.set(p.relativePath, group);
	}

	for (const [relativePath, repoPatches] of byRepo) {
		const nestedDir = path.join(repoRoot, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}

		const combinedDiff = repoPatches.map(p => p.patch).join("\n");
		for (const { patch } of repoPatches) {
			await git.patch.applyText(nestedDir, patch);
		}

		// Commit so nested repo history reflects the task changes
		if ((await git.status(nestedDir)).trim().length > 0) {
			const msg = (await commitMessage?.(combinedDiff)) ?? "changes from isolated task(s)";
			await git.stage.files(nestedDir);
			await git.commit(nestedDir, msg);
		}
	}
}

export async function cleanupWorktree(dir: string): Promise<void> {
	try {
		const repository = await git.repo.resolve(dir);
		const commonDir = repository?.commonDir ?? "";
		if (commonDir && path.basename(commonDir) === ".git") {
			const repoRoot = path.dirname(commonDir);
			await git.worktree.tryRemove(repoRoot, dir);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Fuse-overlay isolation (Unix)
// ═══════════════════════════════════════════════════════════════════════════

export async function ensureFuseOverlay(baseCwd: string, id: string): Promise<string> {
	if (process.platform === "win32") {
		throw new Error('fuse-overlay isolation is unsupported on Windows. Use task.isolation.mode = "fuse-projfs".');
	}

	const repoRoot = await getRepoRoot(baseCwd);
	const encodedProject = getEncodedProjectName(repoRoot);
	const baseDir = getWorktreeDir(encodedProject, id);
	const upperDir = path.join(baseDir, "upper");
	const workDir = path.join(baseDir, "work");
	const mergedDir = path.join(baseDir, "merged");

	// Clean up any stale mount at this path (linux only)
	const fusermount = $which("fusermount3") ?? $which("fusermount");
	if (fusermount) {
		await $`${fusermount} -u ${mergedDir}`.quiet().nothrow();
	}

	await fs.rm(baseDir, { recursive: true, force: true });
	await fs.mkdir(upperDir, { recursive: true });
	await fs.mkdir(workDir, { recursive: true });
	await fs.mkdir(mergedDir, { recursive: true });

	const binary = $which("fuse-overlayfs");
	if (!binary) {
		await fs.rm(baseDir, { recursive: true, force: true });
		throw new Error(
			"fuse-overlayfs not found. Install it (e.g. `apt install fuse-overlayfs` or `pacman -S fuse-overlayfs`) to use fuse-overlay isolation.",
		);
	}

	const result = await $`${binary} -o lowerdir=${repoRoot},upperdir=${upperDir},workdir=${workDir} ${mergedDir}`
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		await fs.rm(baseDir, { recursive: true, force: true });
		throw new Error(`fuse-overlayfs mount failed (exit ${result.exitCode}): ${stderr}`);
	}

	return mergedDir;
}

export async function cleanupFuseOverlay(mergedDir: string): Promise<void> {
	try {
		const fusermount = $which("fusermount3") ?? $which("fusermount");
		if (fusermount) {
			await $`${fusermount} -u ${mergedDir}`.quiet().nothrow();
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// ProjFS isolation (Windows)
// ═══════════════════════════════════════════════════════════════════════════

export async function ensureProjfsOverlay(baseCwd: string, id: string): Promise<string> {
	if (process.platform !== "win32") {
		throw new Error("fuse-projfs isolation is only available on Windows.");
	}

	const repoRoot = await getRepoRoot(baseCwd);
	const encodedProject = getEncodedProjectName(repoRoot);
	const baseDir = getWorktreeDir(encodedProject, id);
	const mergedDir = path.join(baseDir, "merged");

	await fs.rm(baseDir, { recursive: true, force: true });
	await fs.mkdir(mergedDir, { recursive: true });
	try {
		projfsOverlayStart(repoRoot, mergedDir);
		return mergedDir;
	} catch (err) {
		await fs.rm(baseDir, { recursive: true, force: true });
		throw err;
	}
}

export async function cleanupProjfsOverlay(mergedDir: string): Promise<void> {
	try {
		if (process.platform === "win32") {
			try {
				projfsOverlayStop(mergedDir);
			} catch (err) {
				logger.warn("ProjFS overlay stop failed during cleanup", {
					mergedDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface CommitToBranchResult {
	branchName?: string;
	nestedPatches: NestedRepoPatch[];
}

/**
 * Commit task-only changes to a new branch.
 * Only root repo changes go on the branch. Nested repo patches are returned
 * separately since the parent git can't track files inside gitlinks.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;

	const repoRoot = baseline.root.repoRoot;
	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	// Only create a branch if the root repo has changes
	if (rootPatch.trim()) {
		await git.branch.create(repoRoot, branchName);
		const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
		try {
			await git.worktree.add(repoRoot, tmpDir, branchName);
			try {
				await git.patch.applyText(tmpDir, rootPatch);
			} catch (err) {
				if (err instanceof git.GitCommandError) {
					const stderr = err.result.stderr.slice(0, 2000);
					logger.error("commitToBranch: git apply failed", {
						taskId,
						exitCode: err.result.exitCode,
						stderr,
						patchSize: rootPatch.length,
						patchHead: rootPatch.slice(0, 500),
					});
					throw new Error(`git apply failed for task ${taskId}: ${stderr}`);
				}
				throw err;
			}
			await git.stage.files(tmpDir);
			const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
			await git.commit(tmpDir, msg);
		} finally {
			await git.worktree.tryRemove(repoRoot, tmpDir);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	return { branchName: rootPatch.trim() ? branchName : undefined, nestedPatches };
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD.
 * Each branch has a single commit that gets replayed cleanly.
 * Stops on first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string }>,
): Promise<MergeBranchResult> {
	const merged: string[] = [];
	const failed: string[] = [];

	// Stash dirty working tree so cherry-pick can operate on a clean HEAD.
	// Without this, cherry-pick refuses to run when uncommitted changes exist.
	const didStash = await git.stash.push(repoRoot, "omp-task-merge");

	let conflictResult: MergeBranchResult | undefined;

	try {
		for (const { branchName } of branches) {
			try {
				await git.cherryPick(repoRoot, branchName);
			} catch (err) {
				try {
					await git.cherryPick.abort(repoRoot);
				} catch {
					/* no state to abort */
				}
				const stderr =
					err instanceof git.GitCommandError
						? err.result.stderr.trim()
						: err instanceof Error
							? err.message
							: String(err);
				failed.push(branchName);
				conflictResult = {
					merged,
					failed: [...failed, ...branches.slice(merged.length + failed.length).map(b => b.branchName)],
					conflict: `${branchName}: ${stderr}`,
				};
				break;
			}

			merged.push(branchName);
		}
	} finally {
		if (didStash) {
			try {
				await git.stash.pop(repoRoot, { index: true });
			} catch {
				// Stash-pop conflicts mean the replayed changes clash with the user's
				// uncommitted edits. Treat this as a merge failure so the caller preserves
				// recovery branches instead of reporting success and deleting them.
				logger.warn("Failed to restore stashed changes after task merge; stash entry preserved");
				if (!conflictResult) {
					conflictResult = {
						merged,
						failed: merged,
						conflict:
							"stash pop: cherry-picked changes conflict with uncommitted edits. Run `git stash pop` and resolve manually.",
					};
				}
			}
		}
	}

	return conflictResult ?? { merged, failed };
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	for (const branch of branches) {
		await git.branch.tryDelete(repoRoot, branch);
	}
}
