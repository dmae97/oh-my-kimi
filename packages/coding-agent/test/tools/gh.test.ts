import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

function createSession(
	cwd: string = "/tmp/test",
	settings: Settings = Settings.isolated({ "github.enabled": true }),
	artifactsDir?: string,
): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => artifactsDir ?? null,
		allocateOutputArtifact: artifactsDir
			? async toolType => {
					const artifactId = String(nextArtifactId++);
					return {
						id: artifactId,
						path: path.join(artifactsDir, `${artifactId}-${toolType}.md`),
					};
				}
			: undefined,
		getSessionSpawns: () => null,
		settings,
	};
}

function createToolContext(settings: Settings): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as AgentToolContext;
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
	}

	return new TextDecoder().decode(result.stdout).trim();
}

async function createPrFixture(): Promise<{
	baseDir: string;
	repoRoot: string;
	originBare: string;
	forkBare: string;
	headRefName: string;
	headRefOid: string;
}> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-"));
	const repoRoot = path.join(baseDir, "repo");
	const originBare = path.join(baseDir, "origin.git");
	const forkBare = path.join(baseDir, "fork.git");
	const headRefName = "feature/contributor-fix";

	await fs.mkdir(repoRoot, { recursive: true });
	runGit(baseDir, ["init", "--bare", originBare]);
	runGit(baseDir, ["init", "--bare", forkBare]);
	runGit(baseDir, ["init", "-b", "main", repoRoot]);
	runGit(repoRoot, ["config", "user.name", "Test User"]);
	runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
	runGit(repoRoot, ["add", "README.md"]);
	runGit(repoRoot, ["commit", "-m", "base commit"]);
	runGit(repoRoot, ["remote", "add", "origin", originBare]);
	runGit(repoRoot, ["push", "-u", "origin", "main"]);
	runGit(repoRoot, ["remote", "add", "forksrc", forkBare]);
	runGit(repoRoot, ["checkout", "-b", headRefName]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\nfeature\n");
	runGit(repoRoot, ["add", "README.md"]);
	runGit(repoRoot, ["commit", "-m", "feature commit"]);
	const headRefOid = runGit(repoRoot, ["rev-parse", "HEAD"]);
	runGit(repoRoot, ["push", "-u", "forksrc", headRefName]);
	runGit(repoRoot, ["checkout", "main"]);

	return {
		baseDir,
		repoRoot,
		originBare,
		forkBare,
		headRefName,
		headRefOid,
	};
}

describe("github tool", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("formats repository metadata into readable text", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			nameWithOwner: "cli/cli",
			description: "GitHub CLI",
			url: "https://github.com/cli/cli",
			defaultBranchRef: { name: "trunk" },
			homepageUrl: "https://cli.github.com",
			forkCount: 1234,
			isArchived: false,
			isFork: false,
			primaryLanguage: { name: "Go" },
			repositoryTopics: [{ name: "cli" }, { name: "github" }],
			stargazerCount: 4567,
			updatedAt: "2026-04-01T10:00:00Z",
			viewerPermission: "WRITE",
			visibility: "PUBLIC",
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("repo-view", { op: "repo_view", repo: "cli/cli" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# cli/cli");
		expect(text).toContain("GitHub CLI");
		expect(text).toContain("Default branch: trunk");
		expect(text).toContain("Stars: 4567");
		expect(text).toContain("Topics: cli, github");
	});

	it("formats issue comments and omits minimized ones", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			number: 42,
			title: "Example issue",
			state: "OPEN",
			stateReason: null,
			author: { login: "octocat" },
			body: "Issue body",
			createdAt: "2026-04-01T09:00:00Z",
			updatedAt: "2026-04-01T10:00:00Z",
			url: "https://github.com/cli/cli/issues/42",
			labels: [{ name: "bug" }],
			comments: [
				{
					author: { login: "reviewer" },
					body: "Visible comment",
					createdAt: "2026-04-01T11:00:00Z",
					url: "https://github.com/cli/cli/issues/42#issuecomment-1",
					isMinimized: false,
				},
				{
					author: { login: "spam" },
					body: "Hidden comment",
					createdAt: "2026-04-01T12:00:00Z",
					url: "https://github.com/cli/cli/issues/42#issuecomment-2",
					isMinimized: true,
					minimizedReason: "SPAM",
				},
			],
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("issue-view", {
			op: "issue_view",
			issue: "42",
			repo: "cli/cli",
			comments: true,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# Issue #42: Example issue");
		expect(text).toContain("Labels: bug");
		expect(text).toContain("### @reviewer · 2026-04-01T11:00:00Z");
		expect(text).toContain("Visible comment");
		expect(text).toContain("Minimized comments omitted: 1.");
		expect(text).not.toContain("Hidden comment");
	});

	it("includes pull request reviews and inline review comments in the discussion context", async () => {
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/cli/cli/pulls/12/comments")) {
				return [
					{
						id: 501,
						body: "Please rename this helper.",
						path: "src/file.ts",
						line: 17,
						side: "RIGHT",
						user: { login: "inline-reviewer" },
						created_at: "2026-04-01T11:30:00Z",
						html_url: "https://github.com/cli/cli/pull/12#discussion_r1",
					},
				] as never;
			}

			return {
				number: 12,
				title: "Improve PR context",
				state: "OPEN",
				author: { login: "octocat" },
				body: "PR body",
				baseRefName: "main",
				headRefName: "feature/pr-reviews",
				isDraft: false,
				mergeStateStatus: "CLEAN",
				reviewDecision: "CHANGES_REQUESTED",
				createdAt: "2026-04-01T09:00:00Z",
				updatedAt: "2026-04-01T10:00:00Z",
				url: "https://github.com/cli/cli/pull/12",
				labels: [{ name: "bug" }],
				files: [{ path: "src/file.ts", additions: 3, deletions: 1, changeType: "MODIFIED" }],
				reviews: [
					{
						author: { login: "reviewer" },
						body: "Please add coverage for this path.",
						state: "CHANGES_REQUESTED",
						submittedAt: "2026-04-01T11:00:00Z",
						commit: { oid: "abcdef1234567890" },
					},
				],
				comments: [],
			} as never;
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-view", {
			op: "pr_view",
			pr: "12",
			repo: "cli/cli",
			comments: true,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("## Reviews (1)");
		expect(text).toContain("### @reviewer - 2026-04-01T11:00:00Z [CHANGES_REQUESTED]");
		expect(text).toContain("Commit: abcdef123456");
		expect(text).toContain("Please add coverage for this path.");
		expect(text).toContain("## Review Comments (1)");
		expect(text).toContain("### @inline-reviewer · 2026-04-01T11:30:00Z");
		expect(text).toContain("Location: src/file.ts:17");
		expect(text).toContain("Please rename this helper.");
	});

	it("formats pull request search results", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue([
			{
				number: 101,
				title: "Add feature",
				state: "OPEN",
				author: { login: "dev1" },
				repository: { nameWithOwner: "owner/repo" },
				labels: [{ name: "feature" }],
				createdAt: "2026-04-01T08:00:00Z",
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/owner/repo/pull/101",
			},
			{
				number: 102,
				title: "Fix regression",
				state: "CLOSED",
				author: { login: "dev2" },
				repository: { nameWithOwner: "owner/repo" },
				labels: [],
				createdAt: "2026-03-31T08:00:00Z",
				updatedAt: "2026-03-31T09:00:00Z",
				url: "https://github.com/owner/repo/pull/102",
			},
		]);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-prs", {
			op: "search_prs",
			query: "feature",
			repo: "owner/repo",
			limit: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub pull requests search");
		expect(text).toContain("Query: feature");
		expect(text).toContain("Repository: owner/repo");
		expect(text).toContain("- #101 Add feature");
		expect(text).toContain("  Labels: feature");
		expect(text).toContain("- #102 Fix regression");
	});

	it("passes leading-dash search queries after -- so gh does not parse them as flags", async () => {
		const runGhJsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([]);

		const tool = new GithubTool(createSession());
		await tool.execute("search-issues", {
			op: "search_issues",
			query: "-label:bug",
			repo: "owner/repo",
			limit: 1,
		});
		await tool.execute("search-prs", {
			op: "search_prs",
			query: "-label:bug",
			repo: "owner/repo",
			limit: 1,
		});

		const issueArgs = runGhJsonSpy.mock.calls[0]?.[1];
		const prArgs = runGhJsonSpy.mock.calls[1]?.[1];

		expect(issueArgs?.slice(0, 2)).toEqual(["search", "issues"]);
		expect(issueArgs?.at(2)).toBe("--limit");
		expect(issueArgs?.at(-2)).toBe("--");
		expect(issueArgs?.at(-1)).toBe("-label:bug");
		expect(prArgs?.slice(0, 2)).toEqual(["search", "prs"]);
		expect(prArgs?.at(2)).toBe("--limit");
		expect(prArgs?.at(-2)).toBe("--");
		expect(prArgs?.at(-1)).toBe("-label:bug");
	});

	it("returns diff output under a stable heading without rewriting patch content", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue("diff --git a/Makefile b/Makefile\n+\tgo test ./... \n");

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-diff", { op: "pr_diff", pr: "7", repo: "owner/repo" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# Pull Request Diff");
		expect(text).toContain("diff --git a/Makefile b/Makefile");
		expect(text).toContain("+\tgo test ./... ");
		expect(text).not.toContain("+    go test ./... ");
	});

	it("lets wrapped GitHub diff output spill to an artifact tail instead of head-truncating", async () => {
		const diffOutput = Array.from({ length: 400 }, (_, index) => `diff line ${index + 1}`).join("\n");
		vi.spyOn(git.github, "text").mockResolvedValue(diffOutput);

		const settings = Settings.isolated({
			"github.enabled": true,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 20,
		});
		const tool = wrapToolWithMetaNotice(new GithubTool(createSession("/tmp/test", settings)));
		const result = await tool.execute(
			"pr-diff",
			{ op: "pr_diff", pr: "7", repo: "owner/repo" },
			undefined,
			undefined,
			createToolContext(settings),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("diff line 400");
		expect(text).not.toContain("diff line 1");
		expect(text).toContain("Read artifact://");
		expect(text).not.toContain("Use offset=");
		expect(result.details?.meta?.truncation?.direction).toBe("tail");
	});

	it("checks out a pull request into a worktree and configures contributor push metadata", async () => {
		const fixture = await createPrFixture();
		try {
			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 123,
					title: "Contributor fix",
					url: "https://github.com/base/repo/pull/123",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					headRepository: { nameWithOwner: "contrib/repo" },
					headRepositoryOwner: { login: "contrib" },
					isCrossRepository: true,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					nameWithOwner: "contrib/repo",
					sshUrl: fixture.forkBare,
					url: fixture.forkBare,
				});

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: "123" });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const worktreePath = await fs.realpath(path.join(fixture.repoRoot, ".worktrees", "pr-123"));

			expect(text).toContain("Checked Out Pull Request #123");
			expect(text).toContain(`Worktree: ${worktreePath}`);
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-123.pushRemote"])).toBe("forksrc");
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-123.merge"])).toBe(
				`refs/heads/${fixture.headRefName}`,
			);
			expect(runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"])).toContain(`worktree ${worktreePath}`);
			expect(runGit(worktreePath, ["branch", "--show-current"])).toBe("pr-123");
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("rejects PR pushes from branches without checkout metadata", async () => {
		const fixture = await createPrFixture();
		try {
			const originMainBefore = runGit(fixture.baseDir, [
				"--git-dir",
				fixture.originBare,
				"rev-parse",
				"refs/heads/main",
			]);
			runGit(fixture.repoRoot, ["checkout", "-b", "manual-branch", "origin/main"]);
			await Bun.write(path.join(fixture.repoRoot, "README.md"), "base\nmanual\n");
			runGit(fixture.repoRoot, ["add", "README.md"]);
			runGit(fixture.repoRoot, ["commit", "-m", "manual branch commit"]);

			const tool = new GithubTool(createSession(fixture.repoRoot));

			await expect(tool.execute("pr-push", { op: "pr_push" })).rejects.toThrow(
				"branch manual-branch has no PR push metadata; check it out via op: pr_checkout first",
			);
			expect(runGit(fixture.baseDir, ["--git-dir", fixture.originBare, "rev-parse", "refs/heads/main"])).toBe(
				originMainBefore,
			);
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("exposes a flat op-based schema without legacy run_watch parameters", () => {
		const tool = new GithubTool(createSession());
		const properties = tool.parameters.properties as Record<string, unknown>;
		expect(properties.op).toBeDefined();
		expect(properties.interval).toBeUndefined();
		expect(properties.grace).toBeUndefined();
	});

	it("tails failed job logs inline and saves the full failed-job logs as an artifact", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-run-watch-artifacts-"));
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				id: 77,
				name: "CI",
				display_title: "PR checks",
				status: "completed",
				conclusion: "failure",
				head_branch: "feature/bugfix",
				created_at: "2026-04-01T08:00:00Z",
				updated_at: "2026-04-01T08:06:00Z",
				html_url: "https://github.com/owner/repo/actions/runs/77",
			})
			.mockResolvedValueOnce({
				total_count: 2,
				jobs: [
					{
						id: 201,
						name: "build",
						status: "completed",
						conclusion: "success",
						started_at: "2026-04-01T08:00:00Z",
						completed_at: "2026-04-01T08:02:00Z",
						html_url: "https://github.com/owner/repo/actions/runs/77/job/201",
					},
					{
						id: 202,
						name: "test",
						status: "completed",
						conclusion: "failure",
						started_at: "2026-04-01T08:00:00Z",
						completed_at: "2026-04-01T08:06:00Z",
						html_url: "https://github.com/owner/repo/actions/runs/77/job/202",
					},
				],
			});
		vi.spyOn(git.github, "run").mockResolvedValue({
			exitCode: 0,
			stdout: "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta",
			stderr: "",
		});

		try {
			const tool = new GithubTool(
				createSession("/tmp/test", Settings.isolated({ "github.enabled": true }), artifactsDir),
			);
			const result = await tool.execute("run-watch", {
				op: "run_watch",
				run: "https://github.com/owner/repo/actions/runs/77",
				tail: 3,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(text).toContain("# GitHub Actions Run #77");
			expect(text).toContain("Repository: owner/repo");
			expect(text).toContain("### test [failure]");
			expect(text).toContain("delta");
			expect(text).toContain("epsilon");
			expect(text).toContain("zeta");
			expect(text).not.toContain("alpha");
			expect(text).toContain("Run failed.");
			expect(text).toContain("Full failed-job logs: artifact://0");
			expect(result.details?.artifactId).toBe("0");
			expect(result.details?.watch?.mode).toBe("run");
			expect(result.details?.watch?.state).toBe("completed");
			expect(result.details?.watch?.failedLogs?.[0]?.jobName).toBe("test");
			expect(result.details?.watch?.failedLogs?.[0]?.tail).toContain("zeta");

			const artifactText = await Bun.file(path.join(artifactsDir, "0-github.md")).text();
			expect(artifactText).toContain("# GitHub Actions Run #77");
			expect(artifactText).toContain("Full log:");
			expect(artifactText).toContain("alpha");
			expect(artifactText).toContain("beta");
			expect(artifactText).toContain("gamma");
			expect(artifactText).toContain("delta");
			expect(artifactText).toContain("epsilon");
			expect(artifactText).toContain("zeta");
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true });
		}
	});
});
