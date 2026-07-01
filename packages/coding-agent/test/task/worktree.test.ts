import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getGitNoIndexNullPath,
	getRepoRoot,
	mergeTaskBranches,
	parseIsolationMode,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as natives from "@oh-my-pi/pi-natives";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createGitRepo(): Promise<{ baseBranch: string; repo: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "merged.txt"), "base version\n");
	await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return {
		baseBranch: await runGit(repo, ["branch", "--show-current"]),
		repo,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	jj.repo.clearRootCache();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("maps every isolation mode to the native backend contract", () => {
		expect(parseIsolationMode("none")).toBeUndefined();
		expect(parseIsolationMode("auto")).toBeUndefined();
		expect(parseIsolationMode("apfs")).toBe(natives.IsoBackendKind.Apfs);
		expect(parseIsolationMode("btrfs")).toBe(natives.IsoBackendKind.Btrfs);
		expect(parseIsolationMode("zfs")).toBe(natives.IsoBackendKind.Zfs);
		expect(parseIsolationMode("reflink")).toBe(natives.IsoBackendKind.LinuxReflink);
		expect(parseIsolationMode("overlayfs")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("fuse-overlay")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("fuse-projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("block-clone")).toBe(natives.IsoBackendKind.WindowsBlockClone);
		expect(parseIsolationMode("rcopy")).toBe(natives.IsoBackendKind.Rcopy);
		expect(parseIsolationMode("worktree")).toBe(natives.IsoBackendKind.Rcopy);
	});

	// Real git worktree/stash/merge I/O is the contract under test and cannot be
	// faked. One initialized fixture repo is built once in `beforeAll` (whose time
	// is excluded from per-test body time) and shared: the costly `git init`,
	// initial commit, and the immutable mergeable task branch are all set up there.
	// Tests that rewind the fixture do so with a cheap `reset --hard`; the read-only
	// and first-mutator tests run straight off the pristine fixture.
	describe("git-backed worktree helpers", () => {
		const BASE_BRANCH = "main";
		const TASK_BRANCH = "task/merge-staged";
		let repo: string;
		let initialSha: string;

		beforeAll(async () => {
			repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-"));
			await runGit(repo, ["init", "-q", "-b", BASE_BRANCH]);
			await runGit(repo, ["config", "user.email", "test@example.com"]);
			await runGit(repo, ["config", "user.name", "Test User"]);
			await Promise.all([
				fs.writeFile(path.join(repo, "merged.txt"), "base version\n"),
				fs.writeFile(path.join(repo, "staged.txt"), "base staged\n"),
			]);
			await runGit(repo, ["add", "."]);
			await runGit(repo, ["commit", "-q", "-m", "initial"]);
			initialSha = await runGit(repo, ["rev-parse", "HEAD"]);

			// Immutable fixture branch with a single mergeable commit. mergeTaskBranches
			// cherry-picks (reads) it without mutating it, so it survives `reset --hard`
			// and never needs rebuilding per test.
			await runGit(repo, ["checkout", "-q", "-b", TASK_BRANCH]);
			await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
			await runGit(repo, ["commit", "-q", "-am", "task-change"]);
			await runGit(repo, ["checkout", "-q", BASE_BRANCH]);
		});

		afterAll(async () => {
			await removeWithRetries(repo);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("retries isoResolve candidates when a backend is path-unavailable", async () => {
			const unavailable = new Error("ISO_UNAVAILABLE: btrfs source is not a subvolume");
			const isoResolve = vi.spyOn(natives, "isoResolve").mockReturnValue({
				kind: natives.IsoBackendKind.Btrfs,
				candidates: [natives.IsoBackendKind.Btrfs, natives.IsoBackendKind.Rcopy],
				fellBack: false,
				reason: undefined,
			});
			const isoStart = vi
				.spyOn(natives, "isoStart")
				.mockRejectedValueOnce(unavailable)
				.mockResolvedValueOnce(undefined);
			vi.spyOn(natives, "isoIsUnavailableError").mockImplementation(message =>
				message.startsWith("ISO_UNAVAILABLE:"),
			);

			const handle = await ensureIsolation(repo, "retry-path-unavailable");

			expect(isoResolve).toHaveBeenCalledWith(null);
			expect(isoStart.mock.calls.map(call => call[0])).toEqual([
				natives.IsoBackendKind.Btrfs,
				natives.IsoBackendKind.Rcopy,
			]);
			expect(handle.backend).toBe(natives.IsoBackendKind.Rcopy);
			expect(handle.fellBack).toBe(true);
			expect(handle.fallbackReason).toBe(unavailable.message);
		});

		it("uses compact isolation paths that do not embed long task ids", async () => {
			const originalWorktreeDir = process.env.OMP_WORKTREE_DIR;
			const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-base-"));
			tempDirs.push(worktreeBase);
			delete process.env.OMP_WORKTREE_DIR;
			setWorktreesDir(worktreeBase);
			vi.spyOn(natives, "isoResolve").mockReturnValue({
				kind: natives.IsoBackendKind.Rcopy,
				candidates: [natives.IsoBackendKind.Rcopy],
				fellBack: false,
				reason: undefined,
			});
			vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);

			try {
				const longTaskId = "orchestrate-goal-execution.Test1-0982d2a";
				const handle = await ensureIsolation(repo, longTaskId);
				const mergedLeaf = path.basename(handle.mergedDir);
				const isolationSegment = path.basename(path.dirname(handle.mergedDir));

				expect(mergedLeaf).toBe("m");
				expect(isolationSegment).not.toContain(longTaskId);
				expect(isolationSegment.length).toBeLessThanOrEqual(12);
			} finally {
				if (originalWorktreeDir === undefined) {
					delete process.env.OMP_WORKTREE_DIR;
				} else {
					process.env.OMP_WORKTREE_DIR = originalWorktreeDir;
				}
				setWorktreesDir(undefined);
			}
		});

		// First mutator: runs on the pristine fixture, so no reset is needed. Leaves
		// behind a stash that the next test's reset clears.
		it("does not pop an unrelated pre-existing stash when the working tree is clean", async () => {
			// A tracked-file edit makes the cheapest possible "unrelated" stash; the
			// kind of stash is irrelevant — mergeTaskBranches must not pop one it did
			// not create. Stashing restores the working tree to clean.
			await fs.writeFile(path.join(repo, "merged.txt"), "unrelated user change\n");
			await runGit(repo, ["stash", "push", "-m", "preexisting-user-stash"]);

			const result = await mergeTaskBranches(repo, []);

			const [stashList, status] = await Promise.all([
				runGit(repo, ["stash", "list"]),
				runGit(repo, ["status", "--porcelain=v1"]),
			]);
			expect(result).toEqual({ failed: [], merged: [] });
			const stashEntries = stashList.split("\n").filter(Boolean);
			expect(stashEntries).toHaveLength(1);
			expect(stashEntries[0]).toContain("preexisting-user-stash");
			expect(status).toBe("");
		});

		// These rewind the fixture so each starts from the pristine post-`initial`
		// state: `reset --hard` restores HEAD + index + tracked files and the parallel
		// `stash clear` drops any leftover stash. No `git clean` is needed — none of
		// these tests leave untracked files behind (the baseline test commits its own).
		// The fixture branch is untouched by `reset --hard`.
		describe("after rewinding the shared fixture", () => {
			beforeEach(async () => {
				await Promise.all([runGit(repo, ["reset", "-q", "--hard", initialSha]), runGit(repo, ["stash", "clear"])]);
			});

			it("restores staged changes with index preservation after merging task branches", async () => {
				await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
				await runGit(repo, ["add", "staged.txt"]);

				const result = await mergeTaskBranches(repo, [{ branchName: TASK_BRANCH, taskId: "task-1" }]);

				const [mergedContent, status, cached, stashList] = await Promise.all([
					fs.readFile(path.join(repo, "merged.txt"), "utf8"),
					runGit(repo, ["status", "--porcelain=v1"]),
					runGit(repo, ["diff", "--cached", "--", "staged.txt"]),
					runGit(repo, ["stash", "list"]),
				]);
				expect(result).toEqual({ failed: [], merged: [TASK_BRANCH] });
				expect(mergedContent).toBe("task branch change\n");
				expect(status).toBe("M  staged.txt");
				expect(cached).toContain("+local staged change");
				expect(stashList).toBe("");
			});

			// Regression for #4175: a stash-pop conflict used to leave stage 1/2/3
			// unmerged entries in `.git/index` (no `MERGE_HEAD`, no way to abort).
			// The corrupted index survived indefinitely and every subsequent
			// overlay-isolated task read it through the lower layer, so
			// `captureRepoDeltaPatch` produced `diff --cc` output that `git apply`
			// rejects. mergeTaskBranches MUST leave the index clean regardless of
			// whether the stash could be popped.
			it("keeps the index clean when stash pop would conflict with a cherry-picked change", async () => {
				// User's WIP touches the same file the task branch modifies, so a
				// naive stash push → cherry-pick → stash pop conflicts on pop.
				await fs.writeFile(path.join(repo, "merged.txt"), "user wip\n");

				const result = await mergeTaskBranches(repo, [{ branchName: TASK_BRANCH, taskId: "task-1" }]);

				const [status, unmerged, stashList, headContent] = await Promise.all([
					runGit(repo, ["status", "--porcelain=v1"]),
					runGit(repo, ["ls-files", "--unmerged"]),
					runGit(repo, ["stash", "list"]),
					fs.readFile(path.join(repo, "merged.txt"), "utf8"),
				]);

				// Cherry-pick landed on HEAD; only the WIP restore was declined.
				expect(result.merged).toEqual([TASK_BRANCH]);
				expect(result.failed).toEqual([]);
				expect(result.stashConflict).toBeDefined();
				// The invariant that was previously broken: no unmerged entries.
				expect(unmerged).toBe("");
				// Working tree matches the merged HEAD, and the WIP is preserved
				// as a stash entry for the user to reconcile manually.
				expect(status).toBe("");
				expect(headContent).toBe("task branch change\n");
				expect(stashList).toContain("omp-task-merge");

				// Downstream contract: with a clean index, captureDeltaPatch
				// produces a valid unified diff (not `diff --cc`) that a
				// subsequent isolated task's `git apply --cached` accepts.
				// Editing a tracked file keeps the shared fixture clean —
				// `reset --hard` on the next test restores it.
				const baseline = await captureBaseline(repo);
				await fs.writeFile(path.join(repo, "staged.txt"), "downstream edit\n");
				const delta = await captureDeltaPatch(repo, baseline);
				expect(delta.rootPatch).not.toContain("diff --cc");
				expect(delta.rootPatch).toContain("+downstream edit");
			});

			it("removes ignored untracked files partially restored before failed stash pop exits", async () => {
				// Force the fallback branch: preflight would normally refuse this
				// pop before Git can restore anything, but mode/delete edge cases can
				// still pass preflight and fail during the actual stash pop. Git can
				// restore unrelated untracked files before reporting the tracked
				// conflict. If the task branch also adds an ignore rule for that
				// restored path, default `git clean -fd -- <path>` leaves it behind;
				// the fallback must clean restored ignored paths too.
				const ignoredBranch = "task/ignored-restored-untracked";
				await runGit(repo, ["checkout", "-q", "-b", ignoredBranch]);
				await Promise.all([
					fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n"),
					fs.writeFile(path.join(repo, ".gitignore"), "note.txt\n"),
				]);
				await runGit(repo, ["add", ".gitignore", "merged.txt"]);
				await runGit(repo, ["commit", "-q", "-m", "task-change-ignored-note"]);
				await runGit(repo, ["checkout", "-q", BASE_BRANCH]);
				try {
					vi.spyOn(git.patch, "canApplyText").mockResolvedValue(true);
					await fs.writeFile(path.join(repo, "merged.txt"), "user wip\n");
					await fs.writeFile(path.join(repo, "note.txt"), "untracked wip\n");

					const result = await mergeTaskBranches(repo, [{ branchName: ignoredBranch, taskId: "task-1" }]);

					const [status, ignoredStatus, unmerged, stashList, headContent, noteExists] = await Promise.all([
						runGit(repo, ["status", "--porcelain=v1"]),
						runGit(repo, ["status", "--porcelain=v1", "--ignored=matching"]),
						runGit(repo, ["ls-files", "--unmerged"]),
						runGit(repo, ["stash", "list"]),
						fs.readFile(path.join(repo, "merged.txt"), "utf8"),
						Bun.file(path.join(repo, "note.txt")).exists(),
					]);

					expect(result.merged).toEqual([ignoredBranch]);
					expect(result.failed).toEqual([]);
					expect(result.stashConflict).toBeDefined();
					expect(unmerged).toBe("");
					expect(status).toBe("");
					expect(ignoredStatus).toBe("");
					expect(noteExists).toBe(false);
					expect(headContent).toBe("task branch change\n");
					expect(stashList).toContain("omp-task-merge");
				} finally {
					await cleanupTaskBranches(repo, [ignoredBranch]);
					await fs.rm(path.join(repo, "note.txt"), { force: true });
				}
			});

			it("commits isolated edits when parent dirt only changes nearby context", async () => {
				const fixtureName = "EXP_DIRTY_TEST.txt";
				const fixturePath = path.join(repo, fixtureName);
				const cleanLines = Array.from({ length: 10 }, (_, index) => `line${index + 1}`);
				await fs.writeFile(fixturePath, `${cleanLines.join("\n")}\n`);
				await runGit(repo, ["add", fixtureName]);
				await runGit(repo, ["commit", "-q", "-m", "add dirty merge fixture"]);

				const parentDirtyLines = cleanLines.map((line, index) => (index === 1 ? "LINE2-DIRTY-PARENT" : line));
				await fs.writeFile(fixturePath, `${parentDirtyLines.join("\n")}\n`);
				const baseline = await captureBaseline(repo);

				const isoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-iso-"));
				tempDirs.push(isoRoot);
				const iso = path.join(isoRoot, "repo");
				await runGit(isoRoot, ["clone", "-q", repo, iso]);
				await runGit(iso, ["config", "user.email", "test@example.com"]);
				await runGit(iso, ["config", "user.name", "Test User"]);
				const isolatedLines = parentDirtyLines.map((line, index) => (index === 4 ? "LINE5-AGENT-EDIT" : line));
				await fs.writeFile(path.join(iso, fixtureName), `${isolatedLines.join("\n")}\n`);

				const taskId = `dirty-context-${path.basename(isoRoot)}`;
				let branchName = `omp/task/${taskId}`;
				try {
					const commitResult = await commitToBranch(iso, baseline, taskId, "dirty context merge");
					if (!commitResult?.branchName) throw new Error("expected task branch");
					branchName = commitResult.branchName;

					const mergeResult = await mergeTaskBranches(repo, [{ branchName, taskId }]);
					const finalContent = await fs.readFile(fixturePath, "utf8");

					expect(mergeResult).toEqual({ failed: [], merged: [branchName] });
					expect(finalContent).toBe(`${isolatedLines.join("\n")}\n`);
				} finally {
					await cleanupTaskBranches(repo, [branchName]);
				}
			});

			it("subtracts baseline dirty state even when the task commits it", async () => {
				await Promise.all([
					fs.writeFile(path.join(repo, "merged.txt"), "baseline dirty change\n"),
					fs.writeFile(path.join(repo, "preexisting.txt"), "baseline untracked\n"),
				]);
				const baseline = await captureBaseline(repo);

				// The task produces new output and commits everything — baseline dirt
				// included. The delta must still subtract the baseline (both the tracked
				// edit and the untracked file) and surface only the task's own addition.
				await fs.writeFile(path.join(repo, "task.txt"), "task output\n");
				await runGit(repo, ["add", "-A"]);
				await runGit(repo, ["commit", "-q", "-m", "committed inside isolation"]);

				const delta = await captureDeltaPatch(repo, baseline);

				expect(delta.nestedPatches).toEqual([]);
				expect(delta.rootPatch).toContain("task.txt");
				expect(delta.rootPatch).toContain("+task output");
				expect(delta.rootPatch).not.toContain("baseline dirty change");
				expect(delta.rootPatch).not.toContain("preexisting.txt");
			});
		});
	});
});

describe("getRepoRoot", () => {
	it("returns the git root for a plain git checkout", async () => {
		const { repo } = await createGitRepo();
		expect(await getRepoRoot(repo)).toBe(repo);
	});

	it("returns the git root for a colocated jj-git workspace", async () => {
		const { repo } = await createGitRepo();
		await fs.mkdir(path.join(repo, ".jj", "repo", "store"), { recursive: true });
		expect(await getRepoRoot(repo)).toBe(repo);
	});

	it("rejects pure jj workspaces with an actionable Jujutsu message", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-purejj-"));
		tempDirs.push(dir);
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await expect(getRepoRoot(dir)).rejects.toThrow(/pure Jujutsu/);
		await expect(getRepoRoot(dir)).rejects.toThrow(/jj git init --colocate/);
	});

	it("preserves the generic git-not-found error for directories without any repo", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-norepo-"));
		tempDirs.push(dir);
		await expect(getRepoRoot(dir)).rejects.toThrow("Git repository not found for isolated task execution.");
	});

	it("rejects a pure jj workspace nested inside an unrelated outer git checkout", async () => {
		// `git.repo.root(inner)` walks up and finds the outer .git — without
		// the pure-jj check running first, isolation would silently target the
		// surrounding git tree behind jj's back.
		const { repo: outer } = await createGitRepo();
		const inner = path.join(outer, "nested-jj");
		await fs.mkdir(path.join(inner, ".jj", "repo", "store"), { recursive: true });

		await expect(getRepoRoot(inner)).rejects.toThrow(/pure Jujutsu/);
		await expect(getRepoRoot(inner)).rejects.toThrow(/jj git init --colocate/);
	});

	it("returns the nested git root when a git checkout lives under an outer jj workspace", async () => {
		// Mirror image of the case above: `jj.repo.root(inner)` finds the outer
		// .jj, but `git.repo.root(inner)` finds the inner .git, so Git
		// automation targets the nested checkout safely. Isolation must keep
		// working here exactly as it did before the pure-jj guard landed.
		const outer = await fs.mkdtemp(path.join(os.tmpdir(), "omp-outerjj-"));
		tempDirs.push(outer);
		await fs.mkdir(path.join(outer, ".jj", "repo", "store"), { recursive: true });
		const inner = path.join(outer, "vendor");
		await fs.mkdir(inner, { recursive: true });
		await runGit(inner, ["init", "-q", "-b", "main"]);
		await runGit(inner, ["config", "user.email", "test@example.com"]);
		await runGit(inner, ["config", "user.name", "Test"]);

		expect(await getRepoRoot(inner)).toBe(inner);
	});
});

describe("applyNestedPatches", () => {
	let parentRepo: string;
	let nestedRel: string;
	let nestedDir: string;

	beforeEach(async () => {
		parentRepo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nested-apply-"));
		await runGit(parentRepo, ["init", "-q", "-b", "main"]);
		await runGit(parentRepo, ["config", "user.email", "test@example.com"]);
		await runGit(parentRepo, ["config", "user.name", "Test User"]);
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "sub/\n");
		await runGit(parentRepo, ["add", "."]);
		await runGit(parentRepo, ["commit", "-q", "-m", "parent-init"]);

		nestedRel = "sub";
		nestedDir = path.join(parentRepo, nestedRel);
		await fs.mkdir(nestedDir, { recursive: true });
		await runGit(nestedDir, ["init", "-q", "-b", "main"]);
		await runGit(nestedDir, ["config", "user.email", "test@example.com"]);
		await runGit(nestedDir, ["config", "user.name", "Test User"]);
		await fs.writeFile(path.join(nestedDir, "file.txt"), "v1\n");
		await runGit(nestedDir, ["add", "."]);
		await runGit(nestedDir, ["commit", "-q", "-m", "nested-init"]);
	});

	afterEach(async () => {
		await removeWithRetries(parentRepo);
	});

	it("does not fold pre-existing dirty nested-repo state into the agent commit", async () => {
		// User has unrelated work-in-progress in the nested repo before the agent runs.
		await fs.writeFile(path.join(nestedDir, "other.txt"), "user wip\n");

		const patch =
			"diff --git a/file.txt b/file.txt\n" +
			"--- a/file.txt\n" +
			"+++ b/file.txt\n" +
			"@@ -1 +1 @@\n" +
			"-v1\n" +
			"+v2\n";
		await applyNestedPatches(parentRepo, [{ relativePath: nestedRel, patch }]);

		const [committedFiles, headContent, otherContent, statusPorcelain] = await Promise.all([
			runGit(nestedDir, ["log", "-1", "--name-only", "--pretty=format:"]),
			fs.readFile(path.join(nestedDir, "file.txt"), "utf8"),
			fs.readFile(path.join(nestedDir, "other.txt"), "utf8"),
			runGit(nestedDir, ["status", "--porcelain=v1"]),
		]);
		expect(committedFiles.trim()).toBe("file.txt");
		expect(headContent).toBe("v2\n");
		expect(otherContent).toBe("user wip\n");
		expect(statusPorcelain).toBe("?? other.txt");
	});

	it("restores pre-existing staged WIP to the index, not just the working tree", async () => {
		// Pre-existing tracked file with a staged edit; the patch should leave
		// this entirely alone, and the stash pop must re-stage it (--index).
		await fs.writeFile(path.join(nestedDir, "other.txt"), "tracked v1\n");
		await runGit(nestedDir, ["add", "other.txt"]);
		await runGit(nestedDir, ["commit", "-q", "-m", "add-other"]);
		await fs.writeFile(path.join(nestedDir, "other.txt"), "staged wip\n");
		await runGit(nestedDir, ["add", "other.txt"]);

		const patch =
			"diff --git a/file.txt b/file.txt\n" +
			"--- a/file.txt\n" +
			"+++ b/file.txt\n" +
			"@@ -1 +1 @@\n" +
			"-v1\n" +
			"+v2\n";
		await applyNestedPatches(parentRepo, [{ relativePath: nestedRel, patch }]);

		const [committedFiles, statusPorcelain, cachedDiff] = await Promise.all([
			runGit(nestedDir, ["log", "-1", "--name-only", "--pretty=format:"]),
			runGit(nestedDir, ["status", "--porcelain=v1"]),
			runGit(nestedDir, ["diff", "--cached", "--", "other.txt"]),
		]);
		expect(committedFiles.trim()).toBe("file.txt");
		// Leading "M " (with trailing space) marks an index-only modification —
		// "M" in the first slot, " " in the second. " M" would mean unstaged.
		expect(statusPorcelain).toBe("M  other.txt");
		expect(cachedDiff).toContain("+staged wip");
	});

	it("returns a stash-restore warning when pop conflicts with the agent commit", async () => {
		// User had unrelated WIP on the same file the agent will edit, so the
		// stash will conflict with the committed version after pop.
		await fs.writeFile(path.join(nestedDir, "file.txt"), "user wip\n");

		const patch =
			"diff --git a/file.txt b/file.txt\n" +
			"--- a/file.txt\n" +
			"+++ b/file.txt\n" +
			"@@ -1 +1 @@\n" +
			"-v1\n" +
			"+v2\n";
		const warnings = await applyNestedPatches(parentRepo, [{ relativePath: nestedRel, patch }]);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not be auto-restored");
		expect(warnings[0]).toContain(nestedRel);

		// Commit landed and the stash entry is preserved for manual recovery.
		const [committedFiles, stashList] = await Promise.all([
			runGit(nestedDir, ["log", "-1", "--name-only", "--pretty=format:"]),
			runGit(nestedDir, ["stash", "list"]),
		]);
		expect(committedFiles.trim()).toBe("file.txt");
		expect(stashList).toContain("omp-isolation-");
	});
});

describe("commitToBranch preserves agent commits", () => {
	let parent: string;
	let isolation: string;

	async function gitr(repo: string, args: string[]): Promise<string> {
		return runGit(repo, args);
	}

	beforeEach(async () => {
		parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-parent-"));
		isolation = await fs.mkdtemp(path.join(os.tmpdir(), "omp-commit-iso-"));
		await gitr(parent, ["init", "-q", "-b", "main"]);
		await gitr(parent, ["config", "user.email", "user@example.com"]);
		await gitr(parent, ["config", "user.name", "Parent User"]);
		await fs.writeFile(
			path.join(parent, "EXP_CLEAN_COMMIT.txt"),
			"line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
		);
		await gitr(parent, ["add", "."]);
		await gitr(parent, ["commit", "-q", "-m", "add clean test fixture"]);

		// Simulate copy-on-write isolation: a real local clone so the agent's
		// commit objects live in `isolation/.git`, just like the overlay/rcopy
		// isolation backends would arrange them at runtime.
		await fs.rm(isolation, { recursive: true, force: true });
		await gitr(parent, ["clone", "-q", "--no-hardlinks", "--local", parent, isolation]);
		await gitr(isolation, ["config", "user.email", "agent@example.com"]);
		await gitr(isolation, ["config", "user.name", "Agent User"]);
	});

	afterEach(async () => {
		await Promise.all([removeWithRetries(parent), removeWithRetries(isolation)]);
	});

	// Reproduces issue #3842: agent commits with a specific message inside
	// isolation; the merged commit on the parent branch must keep that exact
	// message instead of an AI-generated summary.
	it("preserves the agent's commit message after merge", async () => {
		const baseline = await captureBaseline(parent);

		await fs.writeFile(
			path.join(isolation, "EXP_CLEAN_COMMIT.txt"),
			"line1\nline2\nline3\nline4\nLINE5-AGENT-WITH-MESSAGE\nline6\nline7\nline8\nline9\nline10\n",
		);
		await gitr(isolation, ["add", "EXP_CLEAN_COMMIT.txt"]);
		const agentMessage = "fix(test): agent committed with specific message for preservation check";
		await gitr(isolation, ["commit", "-q", "-m", agentMessage]);

		const taskId = "preservation-check";
		const aiMessage = vi.fn(async () => "fix: update line5 in clean commit example");
		const result = await commitToBranch(isolation, baseline, taskId, undefined, aiMessage);

		expect(result?.branchName).toBe(`omp/task/${taskId}`);
		expect(result?.baseSha).toBe(baseline.root.headCommit);
		// commitMessage callback must NOT have been invoked — the agent's
		// message is taken verbatim.
		expect(aiMessage).not.toHaveBeenCalled();

		const branchSubject = await gitr(parent, ["log", "-1", "--pretty=%s", result!.branchName!]);
		expect(branchSubject).toBe(agentMessage);

		const merge = await mergeTaskBranches(parent, [
			{ branchName: result!.branchName!, taskId, baseSha: result!.baseSha! },
		]);
		expect(merge.failed).toEqual([]);
		expect(merge.merged).toEqual([result!.branchName!]);

		const headSubject = await gitr(parent, ["log", "-1", "--pretty=%s"]);
		expect(headSubject).toBe(agentMessage);
	});

	it("preserves every message when the agent makes multiple commits", async () => {
		const baseline = await captureBaseline(parent);

		await fs.writeFile(path.join(isolation, "a.txt"), "alpha\n");
		await gitr(isolation, ["add", "a.txt"]);
		await gitr(isolation, ["commit", "-q", "-m", "feat: add alpha file"]);
		await fs.writeFile(path.join(isolation, "b.txt"), "beta\n");
		await gitr(isolation, ["add", "b.txt"]);
		await gitr(isolation, ["commit", "-q", "-m", "test: add beta coverage"]);

		const result = await commitToBranch(isolation, baseline, "multi", undefined);
		expect(result?.branchName).toBe("omp/task/multi");

		const merge = await mergeTaskBranches(parent, [
			{ branchName: result!.branchName!, taskId: "multi", baseSha: result!.baseSha! },
		]);
		expect(merge).toEqual({ failed: [], merged: ["omp/task/multi"] });

		const subjects = (await gitr(parent, ["log", "-2", "--pretty=%s"])).split("\n");
		expect(subjects).toEqual(["test: add beta coverage", "feat: add alpha file"]);
	});

	it("appends one trailing commit when the agent leaves uncommitted work after committing", async () => {
		const baseline = await captureBaseline(parent);

		await fs.writeFile(path.join(isolation, "a.txt"), "alpha\n");
		await gitr(isolation, ["add", "a.txt"]);
		await gitr(isolation, ["commit", "-q", "-m", "feat: add alpha file"]);
		// Uncommitted change on top of the agent's commit — should land as one
		// extra commit with the AI-generated message, NOT silently dropped.
		await fs.writeFile(path.join(isolation, "b.txt"), "beta\n");

		const aiMessage = vi.fn(async () => "chore: leftover beta wip");
		const result = await commitToBranch(isolation, baseline, "leftover", undefined, aiMessage);
		expect(result?.branchName).toBe("omp/task/leftover");
		expect(aiMessage).toHaveBeenCalledTimes(1);

		const subjects = (await gitr(parent, ["log", "-2", "--pretty=%s", result!.branchName!])).split("\n");
		expect(subjects).toEqual(["chore: leftover beta wip", "feat: add alpha file"]);
	});

	it("filters baseline WIP when the agent commits with git add -A", async () => {
		await fs.writeFile(path.join(parent, "staged.txt"), "baseline staged wip\n");
		await gitr(parent, ["add", "staged.txt"]);
		await fs.writeFile(path.join(parent, "user-wip.txt"), "baseline untracked wip\n");
		await fs.writeFile(path.join(isolation, "staged.txt"), "baseline staged wip\n");
		await gitr(isolation, ["add", "staged.txt"]);
		await fs.writeFile(path.join(isolation, "user-wip.txt"), "baseline untracked wip\n");
		const baseline = await captureBaseline(parent);

		await fs.writeFile(
			path.join(isolation, "EXP_CLEAN_COMMIT.txt"),
			"line1\nline2\nline3\nline4\nLINE5-AGENT-WITH-MESSAGE\nline6\nline7\nline8\nline9\nline10\n",
		);
		await gitr(isolation, ["add", "-A"]);
		const agentMessage = "fix(test): preserve message without baseline wip";
		await gitr(isolation, ["commit", "-q", "-m", agentMessage]);

		const aiMessage = vi.fn(async () => "fix: generated fallback");
		const result = await commitToBranch(isolation, baseline, "dirty-baseline", undefined, aiMessage);
		expect(result?.branchName).toBe("omp/task/dirty-baseline");
		expect(aiMessage).not.toHaveBeenCalled();

		const branchFiles = (await gitr(parent, ["show", "--name-only", "--pretty=format:", result!.branchName!]))
			.split("\n")
			.filter(Boolean);
		expect(branchFiles).toEqual(["EXP_CLEAN_COMMIT.txt"]);

		const merge = await mergeTaskBranches(parent, [
			{ branchName: result!.branchName!, taskId: "dirty-baseline", baseSha: result!.baseSha! },
		]);
		expect(merge).toEqual({ failed: [], merged: ["omp/task/dirty-baseline"] });

		const [headSubject, status, fixture] = await Promise.all([
			gitr(parent, ["log", "-1", "--pretty=%s"]),
			gitr(parent, ["status", "--porcelain=v1"]),
			fs.readFile(path.join(parent, "EXP_CLEAN_COMMIT.txt"), "utf8"),
		]);
		expect(headSubject).toBe(agentMessage);
		expect(status.split("\n").sort()).toEqual(["?? user-wip.txt", "A  staged.txt"]);
		expect(fixture).toContain("LINE5-AGENT-WITH-MESSAGE");
	});

	it("falls back to the AI-generated message when the agent never committed", async () => {
		const baseline = await captureBaseline(parent);

		await fs.writeFile(path.join(isolation, "a.txt"), "alpha\n");

		const aiMessage = vi.fn(async () => "feat: add alpha");
		const result = await commitToBranch(isolation, baseline, "nocommit", undefined, aiMessage);

		expect(result?.branchName).toBe("omp/task/nocommit");
		expect(aiMessage).toHaveBeenCalledTimes(1);

		const branchSubject = await gitr(parent, ["log", "-1", "--pretty=%s", result!.branchName!]);
		expect(branchSubject).toBe("feat: add alpha");
	});

	it("returns null when nothing changed in isolation", async () => {
		const baseline = await captureBaseline(parent);
		const result = await commitToBranch(isolation, baseline, "empty", undefined);
		expect(result).toBeNull();
	});
});
