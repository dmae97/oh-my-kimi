import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureBaseline,
	captureDeltaPatch,
	ensureIsolation,
	getGitNoIndexNullPath,
	mergeTaskBranches,
	parseIsolationMode,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";

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
			await fs.rm(repo, { recursive: true, force: true });
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
