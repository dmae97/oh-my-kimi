import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getGitNoIndexNullPath, mergeTaskBranches } from "../../src/task/worktree";

const isoStartMock = vi.fn();
const isoStopMock = vi.fn();
const isoIsUnavailableErrorMock = vi.fn(
	(message: string) => typeof message === "string" && message.startsWith("ISO_UNAVAILABLE:"),
);
const tempDirs: string[] = [];

// Numeric mirror of the napi-generated const-enum so the production code's
// `IsoBackendKind.Overlayfs` references resolve without loading the addon.
const IsoBackendKind = { Apfs: 0, Overlayfs: 1, Projfs: 2, Rcopy: 3 } as const;

vi.mock("@oh-my-pi/pi-natives", () => ({
	IsoBackendKind,
	isoBackend: vi.fn(() => IsoBackendKind.Rcopy),
	isoDiff: vi.fn(),
	isoIsUnavailableError: isoIsUnavailableErrorMock,
	isoProbe: vi.fn(() => ({ available: true, reason: null, kind: IsoBackendKind.Rcopy })),
	isoStart: isoStartMock,
	isoStop: isoStopMock,
}));

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
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("does not pop an unrelated pre-existing stash when the working tree is clean", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "preexisting.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		const before = await runGit(repo, ["stash", "list"]);

		const result = await mergeTaskBranches(repo, []);

		expect(result).toEqual({ failed: [], merged: [] });
		expect(await runGit(repo, ["stash", "list"])).toBe(before);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("restores staged changes with index preservation after merging task branches", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-staged";
		await runGit(repo, ["checkout", "-b", taskBranch]);
		await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "task-change"]);
		await runGit(repo, ["checkout", baseBranch]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
		await runGit(repo, ["add", "staged.txt"]);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({ failed: [], merged: [taskBranch] });
		expect(await fs.readFile(path.join(repo, "merged.txt"), "utf8")).toBe("task branch change\n");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");
		expect(await runGit(repo, ["diff", "--cached", "--", "staged.txt"])).toContain("+local staged change");
		expect(await runGit(repo, ["stash", "list"])).toBe("");
	});
});
