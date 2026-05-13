/**
 * `issue://` / `pr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache + router singletons. `git.github.json` / `git.github.text` are spied
 * per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pr-protocol-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_GITHUB_CACHE_DB;
	} else {
		process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	}
	vi.restoreAllMocks();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function issuePayload(number: number, body: string, commentBodies: string[] = []) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/issues/${number}`,
		labels: [],
		comments: commentBodies.map((cb, idx) => ({
			author: { login: `user${idx}` },
			body: cb,
			createdAt: "2026-04-01T11:00:00Z",
			url: `https://github.com/owner/example/issues/${number}#issuecomment-${idx + 1}`,
			isMinimized: false,
		})),
	};
}

function prPayload(number: number, body: string) {
	return {
		number,
		title: `PR #${number}`,
		state: "OPEN",
		isDraft: false,
		baseRefName: "main",
		headRefName: "feature/x",
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/pull/${number}`,
		labels: [],
		files: [],
		reviews: [],
		comments: [],
	};
}

describe("issue:// protocol handler", () => {
	it("resolves issue://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(42, "issue body", ["c1"]) as never);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("issue://owner/example/42");

		expect(first.contentType).toBe("text/markdown");
		expect(first.url).toBe("issue://owner/example/42");
		expect(first.content).toContain("# Issue #42: Issue #42");
		expect(first.immutable).toBe(true);
		expect(first.notes?.[0]).toBe("Fetched live");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await router.resolve("issue://owner/example/42");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		// Same key, soft TTL hit — no additional gh invocation.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("?comments=0 selects a separate cache row with comments suppressed", async () => {
		const spy = vi
			.spyOn(git.github, "json")
			.mockResolvedValue(issuePayload(9, "body9", ["visible comment"]) as never);

		const router = InternalUrlRouter.instance();
		const withComments = await router.resolve("issue://owner/example/9");
		const without = await router.resolve("issue://owner/example/9?comments=0");

		// Two distinct keys → two underlying fetches.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(withComments.content).toContain("visible comment");
		expect(without.content).not.toContain("visible comment");
		// Note metadata reflects the toggle on the comments-off variant.
		expect(without.notes).toContain("Comments disabled");
	});

	it("rejects invalid issue:// URLs with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		// 4-or-more segments fall through to the catch-all "Invalid …" error.
		await expect(router.resolve("issue://owner/example/foo/bar")).rejects.toThrow(/Invalid issue:\/\/ URL/);
		// Non-numeric single segment fails the number check.
		await expect(router.resolve("issue://abc")).rejects.toThrow(/Invalid issue:\/\/ number/);
	});
});

describe("pr:// protocol handler", () => {
	it("resolves pr://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/77/comments")) {
				return [] as never;
			}
			return prPayload(77, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77");

		expect(first.contentType).toBe("text/markdown");
		expect(first.content).toContain("# Pull Request #77: PR #77");
		expect(first.immutable).toBe(true);
		// First call hits gh twice (view JSON + review-comments page).
		expect(spy).toHaveBeenCalledTimes(2);

		const second = await router.resolve("pr://owner/example/77");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		// Second call is a soft-TTL hit — no further gh invocations.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("rejects invalid pr:// URLs with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/foo/bar")).rejects.toThrow(/Invalid pr:\/\/ URL/);
		await expect(router.resolve("pr://owner/example/abc")).rejects.toThrow(/Invalid pr:\/\/ number/);
	});
});

describe("issue:// / pr:// listing", () => {
	it("issue://owner/repo issues a live `gh issue list` and renders entries", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				number: 1,
				title: "Hello",
				state: "OPEN",
				author: { login: "alice" },
				labels: [{ name: "bug" }],
				createdAt: "2026-04-01T08:00:00Z",
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/owner/example/issues/1",
			},
			{
				number: 2,
				title: "Second",
				state: "OPEN",
				author: { login: "bob" },
				labels: [],
				createdAt: "2026-04-02T08:00:00Z",
				updatedAt: "2026-04-02T09:00:00Z",
				url: "https://github.com/owner/example/issues/2",
			},
		] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Issues in owner/example");
		expect(resource.content).toContain("#1");
		expect(resource.content).toContain("Hello");
		expect(resource.content).toContain("labels: bug");
		expect(resource.content).toContain("issue://1");
		expect(resource.notes?.[0]).toContain("Live listing for owner/example");

		expect(spy).toHaveBeenCalledTimes(1);
		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args[0]).toBe("issue");
		expect(args[1]).toBe("list");
		expect(args).toEqual(expect.arrayContaining(["--repo", "owner/example"]));
		expect(args).toEqual(expect.arrayContaining(["--state", "open"]));
	});

	it("pr://owner/repo passes state and limit query params through to gh", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example?state=merged&limit=5&author=alice&label=bug");

		expect(resource.content).toContain("# Pull Requests in owner/example (merged, up to 5)");
		expect(resource.content).toContain("_No matches._");

		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--state", "merged"]));
		expect(args).toEqual(expect.arrayContaining(["--limit", "5"]));
		expect(args).toEqual(expect.arrayContaining(["--author", "alice"]));
		expect(args).toEqual(expect.arrayContaining(["--label", "bug"]));
	});

	it("invalid state falls back to 'open' instead of forwarding garbage to gh", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/example?state=banana");

		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--state", "open"]));
	});

	it("issue:// (no repo, no session) surfaces a friendly resolution error", async () => {
		// resolveDefaultRepoMemoized calls `gh repo view`; intercept it.
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("not a git repository"));
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://")).rejects.toThrow(/could not resolve a default repo/);
	});
});

describe("cross-handler cache sharing", () => {
	it("identical markdown is served whether the protocol handler or a second handler call resolves it", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(101, "shared body") as never);

		const router = InternalUrlRouter.instance();
		const r1 = await router.resolve("issue://owner/example/101");
		const r2 = await router.resolve("issue://owner/example/101");
		expect(r2.content).toBe(r1.content);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
