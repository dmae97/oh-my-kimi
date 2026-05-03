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
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

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

/**
 * Stub `os.homedir()` AND rebuild the cached `dirs` resolver in pi-utils so
 * `getWorktreesDir()` resolves under an isolated temp home instead of the
 * user's real `~/.omp/wt`. Returns the temp home and a cleanup hook.
 */
async function setupTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-home-"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
	// `dirs.configRoot` is computed at constructor time from `os.homedir()`, so
	// we must rebuild the resolver after the spy is in place. `setAgentDir`
	// recreates it; we point it at the temp home's default agent dir.
	const originalAgentDir = getAgentDir();
	setAgentDir(path.join(home, ".omp", "agent"));
	return {
		home,
		cleanup: async () => {
			setAgentDir(originalAgentDir);
			await fs.rm(home, { recursive: true, force: true });
		},
	};
}

/**
 * Compute the auto-derived worktree path for a given primary repo root and
 * local branch name, mirroring the encoding used by `pr_checkout`. Resolves
 * symlinks (matches the production `fs.realpath` step) so assertions match
 * the value rendered into the tool result.
 */
async function expectedWorktreePath(home: string, primaryRoot: string, localBranch: string): Promise<string> {
	const encoded = path
		.resolve(primaryRoot)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");
	return fs.realpath(path.join(home, ".omp", "wt", encoded, localBranch));
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

	it("formats code search results with paths, repo, sha, and match fragment", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue([
			{
				path: "src/lib.ts",
				repository: { nameWithOwner: "owner/repo" },
				sha: "abcdef1234567890",
				url: "https://github.com/owner/repo/blob/abcdef1234567890/src/lib.ts",
				textMatches: [{ fragment: "function findThing(): void {\n  ...\n}", property: "content" }],
			},
		]);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-code", {
			op: "search_code",
			query: "findThing",
			repo: "owner/repo",
			limit: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub code search");
		expect(text).toContain("Query: findThing");
		expect(text).toContain("Repository: owner/repo");
		expect(text).toContain("- src/lib.ts");
		expect(text).toContain("  Repo: owner/repo");
		expect(text).toContain("  Commit: abcdef123456");
		expect(text).toContain("  Match: function findThing(): void {");
	});

	it("formats commit search results with short sha and message subject", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue([
			{
				sha: "0123456789abcdef",
				author: { login: "octocat" },
				commit: {
					message: "Fix flaky test\n\nMore detail in the body.",
					author: { name: "Mona Lisa", email: "mona@example.com", date: "2026-04-01T12:00:00Z" },
				},
				repository: { nameWithOwner: "owner/repo" },
				url: "https://github.com/owner/repo/commit/0123456789abcdef",
			},
		]);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-commits", {
			op: "search_commits",
			query: "fix flaky",
			repo: "owner/repo",
			limit: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub commits search");
		expect(text).toContain("- 0123456789ab Fix flaky test");
		expect(text).not.toContain("More detail in the body.");
		expect(text).toContain("  Author: @octocat");
		expect(text).toContain("  Date: 2026-04-01T12:00:00Z");
	});

	it("formats repository search results without forwarding --repo", async () => {
		const runGhJsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				fullName: "octocat/hello-world",
				description: "First line.\nSecond line should not surface.",
				language: "TypeScript",
				stargazersCount: 42,
				forksCount: 7,
				openIssuesCount: 3,
				visibility: "public",
				isArchived: false,
				isFork: false,
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/octocat/hello-world",
			},
		]);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-repos", {
			op: "search_repos",
			query: "language:typescript stars:>100",
			repo: "ignored/value",
			limit: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub repositories search");
		expect(text).toContain("- octocat/hello-world");
		expect(text).toContain("  Description: First line.");
		expect(text).not.toContain("Second line should not surface.");
		expect(text).toContain("  Language: TypeScript");
		expect(text).toContain("  Stars: 42");

		const reposArgs = runGhJsonSpy.mock.calls[0]?.[1];
		expect(reposArgs?.slice(0, 2)).toEqual(["search", "repos"]);
		expect(reposArgs).not.toContain("--repo");
		expect(reposArgs?.at(-2)).toBe("--");
		expect(reposArgs?.at(-1)).toBe("language:typescript stars:>100");
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
		const tempHome = await setupTempHome();
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
			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const worktreePath = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-123");

			expect(text).toContain("Checked Out Pull Request #123");
			expect(text).toContain(`Worktree: ${worktreePath}`);
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-123.pushRemote"])).toBe("forksrc");
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-123.merge"])).toBe(
				`refs/heads/${fixture.headRefName}`,
			);
			expect(runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"])).toContain(`worktree ${worktreePath}`);
			expect(runGit(worktreePath, ["branch", "--show-current"])).toBe("pr-123");
		} finally {
			await tempHome.cleanup();
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("treats git.remote.add as a no-op when the remote already exists with the same URL", async () => {
		const fixture = await createPrFixture();
		try {
			// Fixture already created `forksrc -> forkBare`. A second add with the
			// same URL must succeed silently — this is the cross-process / leftover-
			// state path that used to fail with `error: remote forksrc already exists`.
			await git.remote.add(fixture.repoRoot, "forksrc", fixture.forkBare);
			expect(runGit(fixture.repoRoot, ["remote", "get-url", "forksrc"])).toBe(fixture.forkBare);
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("rejects git.remote.add when the remote already exists with a different URL", async () => {
		const fixture = await createPrFixture();
		try {
			await expect(git.remote.add(fixture.repoRoot, "forksrc", fixture.originBare)).rejects.toThrow(
				/already exists with URL/,
			);
			// Existing URL is preserved — we never overwrote it.
			expect(runGit(fixture.repoRoot, ["remote", "get-url", "forksrc"])).toBe(fixture.forkBare);
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("serializes concurrent git mutations through withRepoLock so callers don't race git's internal locks", async () => {
		const fixture = await createPrFixture();
		try {
			// Without serialization, ~20 concurrent `git config` invocations against
			// the same `.git/config` produce "could not lock config file" failures
			// (the lock is O_EXCL with no waiter). Wrapping each write in
			// `withRepoLock` makes the queue per-repo so all 20 succeed.
			const writes = Array.from({ length: 20 }, (_, idx) =>
				git.withRepoLock(fixture.repoRoot, () =>
					git.config.set(fixture.repoRoot, `branch.race-test.key${idx}`, `value-${idx}`),
				),
			);
			await Promise.all(writes);
			for (let idx = 0; idx < 20; idx += 1) {
				expect(runGit(fixture.repoRoot, ["config", "--get", `branch.race-test.key${idx}`])).toBe(`value-${idx}`);
			}
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("checks out multiple pull requests in a single call when pr is an array", async () => {
		const fixture = await createPrFixture();
		const tempHome = await setupTempHome();
		try {
			// PR #100 reuses the fixture's contributor branch; push it to origin so
			// the non-cross-repo path (which fetches from origin) finds it.
			runGit(fixture.repoRoot, ["push", "origin", `${fixture.headRefName}:${fixture.headRefName}`]);

			// Add a second feature branch on origin so PR #200 has somewhere to come
			// from. Branch names differ to avoid worktree collisions.
			runGit(fixture.repoRoot, ["checkout", "-b", "feature/another", "main"]);
			await Bun.write(path.join(fixture.repoRoot, "OTHER.md"), "other\n");
			runGit(fixture.repoRoot, ["add", "OTHER.md"]);
			runGit(fixture.repoRoot, ["commit", "-m", "another"]);
			const otherOid = runGit(fixture.repoRoot, ["rev-parse", "HEAD"]);
			runGit(fixture.repoRoot, ["push", "-u", "origin", "feature/another"]);
			runGit(fixture.repoRoot, ["checkout", "main"]);

			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 100,
					title: "Same-repo PR 100",
					url: "https://github.com/owner/repo/pull/100",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					isCrossRepository: false,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					number: 200,
					title: "Same-repo PR 200",
					url: "https://github.com/owner/repo/pull/200",
					baseRefName: "main",
					headRefName: "feature/another",
					headRefOid: otherOid,
					isCrossRepository: false,
					maintainerCanModify: true,
				});

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: ["100", "200"] });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const wt100 = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-100");
			const wt200 = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-200");

			expect(text).toContain("# 2 Pull Request Worktrees");
			expect(text).toContain("Checked Out Pull Request #100");
			expect(text).toContain("Checked Out Pull Request #200");
			expect(text).toContain(`Worktree: ${wt100}`);
			expect(text).toContain(`Worktree: ${wt200}`);
			expect(runGit(wt100, ["branch", "--show-current"])).toBe("pr-100");
			expect(runGit(wt200, ["branch", "--show-current"])).toBe("pr-200");
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-100.ompPrUrl"])).toBe(
				"https://github.com/owner/repo/pull/100",
			);
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-200.ompPrUrl"])).toBe(
				"https://github.com/owner/repo/pull/200",
			);

			const summaries = result.details?.checkouts;
			expect(summaries?.length).toBe(2);
			expect(summaries?.map(s => s.prNumber)).toEqual([100, 200]);
			expect(summaries?.every(s => s.reused === false)).toBe(true);
		} finally {
			await tempHome.cleanup();
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("aggregates multiple pull request diffs when pr is an array", async () => {
		vi.spyOn(git.github, "text")
			.mockResolvedValueOnce("diff --git a/one.ts b/one.ts\n+content one\n")
			.mockResolvedValueOnce("diff --git a/two.ts b/two.ts\n+content two\n");

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-diff", { op: "pr_diff", pr: ["10", "20"], repo: "owner/repo" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# 2 Pull Request Diffs");
		expect(text).toContain("## PR 10");
		expect(text).toContain("## PR 20");
		expect(text).toContain("content one");
		expect(text).toContain("content two");
		// Sections are separated by a horizontal rule.
		expect(text.match(/\n---\n/g)?.length).toBe(1);
	});

	it("aggregates multiple pull request views when pr is an array", async () => {
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				number: 11,
				title: "First view",
				url: "https://github.com/owner/repo/pull/11",
				baseRefName: "main",
				headRefName: "feature/one",
				state: "OPEN",
				author: { login: "alice" },
				createdAt: "2026-04-01T09:00:00Z",
				updatedAt: "2026-04-01T10:00:00Z",
				comments: [],
				reviews: [],
			})
			.mockResolvedValueOnce({
				number: 22,
				title: "Second view",
				url: "https://github.com/owner/repo/pull/22",
				baseRefName: "main",
				headRefName: "feature/two",
				state: "OPEN",
				author: { login: "bob" },
				createdAt: "2026-04-01T11:00:00Z",
				updatedAt: "2026-04-01T12:00:00Z",
				comments: [],
				reviews: [],
			});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-view", {
			op: "pr_view",
			pr: ["11", "22"],
			repo: "owner/repo",
			comments: false,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# 2 Pull Requests");
		expect(text).toContain("# Pull Request #11: First view");
		expect(text).toContain("# Pull Request #22: Second view");
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
