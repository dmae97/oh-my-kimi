import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyEligibleNestedPatches, mergeIsolatedChanges } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as gitModule from "@oh-my-pi/pi-coding-agent/utils/git";
import { $ } from "bun";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

const tempRoots: string[] = [];

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.text();
}

async function seedFooRepo(finalContent: string): Promise<{ repoRoot: string; patchPath: string }> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-merge-"));
	tempRoots.push(repoRoot);

	await git(repoRoot, "init");
	await git(repoRoot, "config", "user.email", "repro@example.com");
	await git(repoRoot, "config", "user.name", "Repro");
	await Bun.write(path.join(repoRoot, "foo.txt"), "old\n");
	await git(repoRoot, "add", "foo.txt");
	await git(repoRoot, "commit", "-m", "base");
	await Bun.write(path.join(repoRoot, "foo.txt"), "new\n");
	await git(repoRoot, "commit", "-am", "change to new");

	const patchPath = path.join(repoRoot, "task.patch");
	const patchText = await git(repoRoot, "diff-tree", "--binary", "--full-index", "--no-commit-id", "-p", "HEAD");
	await Bun.write(patchPath, patchText);

	if (finalContent !== "new\n") {
		await git(repoRoot, "reset", "--hard", "HEAD~1");
		if (finalContent !== "old\n") {
			await Bun.write(path.join(repoRoot, "foo.txt"), finalContent);
			await git(repoRoot, "commit", "-am", "diverge");
		}
	}
	return { repoRoot, patchPath };
}

describe("mergeIsolatedChanges", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("surfaces branch preparation errors instead of reporting no changes", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				error: "Merge failed: git apply --3way failed for task dirty-context: conflict",
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
		expect(outcome.summary).toContain("Branch merge failed before a task branch could be created");
		expect(outcome.summary).toContain("git apply --3way failed");
		expect(outcome.summary).not.toContain("No changes to apply");
	});

	it("treats already-applied patch-mode diffs as successful no-ops", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("new\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.summary).not.toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
	});

	it("rejects patch-mode conflicts without dirtying the worktree", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("other\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("other\n");
		expect(await git(repoRoot, "ls-files", "-u", "--", "foo.txt")).toBe("");
	});

	it("applies a fresh patch-mode diff when context matches", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("old\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("new\n");
	});

	it("prefers forward apply when both reverse-check and forward-check succeed", async () => {
		// If git-apply's fuzz ever lets `--reverse --check` succeed while forward
		// `--check` also succeeds (e.g. repeated context with the postimage present
		// elsewhere), the outcome must NOT be a silent no-op.
		const { repoRoot, patchPath } = await seedFooRepo("old\n");
		const canApplySpy = vi.spyOn(gitModule.patch, "canApplyText").mockResolvedValue(true);
		const applySpy = vi.spyOn(gitModule.patch, "applyText").mockResolvedValue(undefined);

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(canApplySpy).toHaveBeenCalledTimes(2);
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});
