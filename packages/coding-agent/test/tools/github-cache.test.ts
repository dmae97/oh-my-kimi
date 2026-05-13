/**
 * Cache-layer tests for `github-cache` (storage + TTL semantics) and for the
 * `getOrFetchIssue` / `getOrFetchPr` wrappers wired into `gh.ts`.
 *
 * Each test isolates `OMP_GITHUB_CACHE_DB` to a temp file and clears
 * `git.github.json` / `git.github.text` mocks between cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getOrFetchIssue, getOrFetchPr } from "@oh-my-pi/pi-coding-agent/tools/gh";
import {
	clearAll,
	getCached,
	getOrFetchView,
	openDb,
	putCached,
	resetForTests as resetCacheForTests,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

const TEST_REPO = "owner/example";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetCacheForTests();
});

afterEach(async () => {
	resetCacheForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_GITHUB_CACHE_DB;
	} else {
		process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	}
	vi.restoreAllMocks();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function issuePayload(number: number, body: string) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/${TEST_REPO}/issues/${number}`,
		labels: [],
		comments: [],
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
		url: `https://github.com/${TEST_REPO}/pull/${number}`,
		labels: [],
		files: [],
		reviews: [],
		comments: [],
	};
}

describe("github-cache db layer", () => {
	it("INSERT OR REPLACE overwrites the row instead of creating duplicates", () => {
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 7,
			includeComments: true,
			payload: issuePayload(7, "first"),
			rendered: "rendered-v1",
			sourceUrl: `https://github.com/${TEST_REPO}/issues/7`,
			fetchedAt: 1000,
		});
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 7,
			includeComments: true,
			payload: issuePayload(7, "second"),
			rendered: "rendered-v2",
			sourceUrl: `https://github.com/${TEST_REPO}/issues/7`,
			fetchedAt: 2000,
		});
		const got = getCached(TEST_REPO, "issue", 7, true);
		expect(got).not.toBeNull();
		expect(got?.rendered).toBe("rendered-v2");
		expect(got?.fetchedAt).toBe(2000);

		const db = openDb();
		const rows = db?.prepare("SELECT COUNT(*) AS c FROM github_view_cache").all() as Array<{ c: number }>;
		expect(rows[0].c).toBe(1);
	});

	it("keys comments-on and comments-off as separate rows", () => {
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 9,
			includeComments: true,
			payload: issuePayload(9, "with-comments"),
			rendered: "with-comments-rendering",
			fetchedAt: 1000,
		});
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 9,
			includeComments: false,
			payload: issuePayload(9, "no-comments"),
			rendered: "no-comments-rendering",
			fetchedAt: 1000,
		});
		const withComments = getCached(TEST_REPO, "issue", 9, true);
		const noComments = getCached(TEST_REPO, "issue", 9, false);
		expect(withComments?.rendered).toBe("with-comments-rendering");
		expect(noComments?.rendered).toBe("no-comments-rendering");
	});

	it("clearAll wipes every row but the schema survives", () => {
		putCached({
			repo: TEST_REPO,
			kind: "pr",
			number: 1,
			includeComments: true,
			payload: prPayload(1, "x"),
			rendered: "x",
			fetchedAt: 1000,
		});
		clearAll();
		expect(getCached(TEST_REPO, "pr", 1, true)).toBeNull();
		const db = openDb();
		expect(db).not.toBeNull();
	});
});

describe("getOrFetchView (TTL semantics)", () => {
	it("returns cached row directly within the soft TTL window", async () => {
		const fetchFresh = vi.fn(async () => ({
			rendered: "fresh",
			sourceUrl: undefined,
			payload: { number: 42 },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 42,
			includeComments: true,
			payload: { number: 42 },
			rendered: "cached",
			fetchedAt: Date.now() - 60_000, // 1 minute ago
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 42,
			includeComments: true,
			fetchFresh,
		});
		expect(result.status).toBe("fresh");
		expect(result.rendered).toBe("cached");
		expect(fetchFresh).not.toHaveBeenCalled();
	});

	it("returns cached row AND schedules a background refresh past soft TTL", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 86400,
		});
		const fetchFresh = vi.fn(async () => ({
			rendered: "refreshed",
			sourceUrl: undefined,
			payload: { number: 50, refreshed: true },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 50,
			includeComments: true,
			payload: { number: 50, refreshed: false },
			rendered: "old",
			fetchedAt: Date.now() - 5 * 60_000, // 5 minutes ago — past soft, before hard
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 50,
			includeComments: true,
			fetchFresh,
			settings,
		});
		expect(result.status).toBe("stale");
		expect(result.rendered).toBe("old");

		// Background refresh runs on a microtask; flush + give the write a tick
		// to land before asserting.
		await Promise.resolve();
		// Wait for the chained .then() (writes) to settle.
		await new Promise<void>(resolve => setTimeout(resolve, 5));

		expect(fetchFresh).toHaveBeenCalledTimes(1);
		const updated = getCached<{ refreshed: boolean }>(TEST_REPO, "issue", 50, true);
		expect(updated?.rendered).toBe("refreshed");
		expect(updated?.payload.refreshed).toBe(true);
	});

	it("treats past-hard-TTL rows as cache misses (fetcher runs)", async () => {
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 60,
			"github.cache.hardTtlSec": 120,
		});
		const fetchFresh = vi.fn(async () => ({
			rendered: "fresh-content",
			sourceUrl: undefined,
			payload: { number: 99 },
		}));
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 99,
			includeComments: true,
			payload: { number: 99 },
			rendered: "ancient",
			fetchedAt: Date.now() - 1_000_000, // way past hard TTL
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 99,
			includeComments: true,
			fetchFresh,
			settings,
		});
		expect(result.status).toBe("miss");
		expect(result.rendered).toBe("fresh-content");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});

	it("bypasses the cache entirely when github.cache.enabled = false", async () => {
		const settings = Settings.isolated({ "github.cache.enabled": false });
		const fetchFresh = vi.fn(async () => ({
			rendered: "always-fresh",
			sourceUrl: undefined,
			payload: { number: 11 },
		}));
		// Pre-populate the cache; with the kill switch the wrapper must ignore it.
		putCached({
			repo: TEST_REPO,
			kind: "issue",
			number: 11,
			includeComments: true,
			payload: { number: 11 },
			rendered: "cached-but-ignored",
			fetchedAt: Date.now(),
		});
		const result = await getOrFetchView({
			repo: TEST_REPO,
			kind: "issue",
			number: 11,
			includeComments: true,
			fetchFresh,
			settings,
		});
		expect(result.status).toBe("disabled");
		expect(result.rendered).toBe("always-fresh");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});
});

describe("getOrFetchIssue (gh-wired wrapper)", () => {
	it("second call within the soft TTL window does not invoke gh", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(123, "body") as never);

		const first = await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "123",
			includeComments: true,
		});
		expect(first.status).toBe("miss");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await getOrFetchIssue({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			issue: "123",
			includeComments: true,
		});
		expect(second.status).toBe("fresh");
		expect(second.rendered).toBe(first.rendered);
		expect(spy).toHaveBeenCalledTimes(1); // unchanged — cache hit
	});

	it("derives (repo, number) from a full GitHub issue URL identifier", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(7, "from-url") as never);
		const url = `https://github.com/${TEST_REPO}/issues/7`;

		await getOrFetchIssue({ cwd: "/tmp/test", issue: url });
		// Second hit by plain number + explicit repo must read the same row.
		await getOrFetchIssue({ cwd: "/tmp/test", repo: TEST_REPO, issue: "7" });
		expect(spy).toHaveBeenCalledTimes(1);

		const cached = getCached(TEST_REPO, "issue", 7, true);
		expect(cached).not.toBeNull();
		expect(cached?.rendered).toContain("Issue #7");
	});

	it("caches comments-on and comments-off separately", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(5, "no-comments-body") as never);

		await getOrFetchIssue({ cwd: "/tmp/test", repo: TEST_REPO, issue: "5", includeComments: false });
		await getOrFetchIssue({ cwd: "/tmp/test", repo: TEST_REPO, issue: "5", includeComments: true });
		// Different keys → two underlying fetches.
		expect(spy).toHaveBeenCalledTimes(2);

		// Each subsequent same-key call hits the cache.
		await getOrFetchIssue({ cwd: "/tmp/test", repo: TEST_REPO, issue: "5", includeComments: false });
		await getOrFetchIssue({ cwd: "/tmp/test", repo: TEST_REPO, issue: "5", includeComments: true });
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("getOrFetchPr (gh-wired wrapper)", () => {
	it("caches PR view by (repo, number) and re-uses on the second call", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(prPayload(77, "pr-body") as never);

		const first = await getOrFetchPr({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			number: 77,
			includeComments: false,
		});
		expect(first.status).toBe("miss");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await getOrFetchPr({
			cwd: "/tmp/test",
			repo: TEST_REPO,
			number: 77,
			includeComments: false,
		});
		expect(second.status).toBe("fresh");
		expect(second.rendered).toBe(first.rendered);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
