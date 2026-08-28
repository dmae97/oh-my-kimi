import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCorpusDigest, evaluateFreshness, evaluateSymbolBinding, runGate } from "../check-openwiki.mjs";

/**
 * Spec 014 security blocker 1: an `interrupted` corpus must FAIL unless a
 * digest-bound manual-review record covers that exact corpus. The old gate
 * warned-and-passed whenever `gitHead` happened to equal HEAD, which meant an
 * unreviewed corpus was trusted right up until the next commit — and then the
 * repository could not accept any commit at all.
 */

const DIGEST_A = "sha256:aaaa";
const DIGEST_B = "sha256:bbbb";
const HEAD = "1111111111111111111111111111111111111111";
const OLD_HEAD = "2222222222222222222222222222222222222222";

const interrupted = (gitHead = HEAD) => ({ status: "interrupted", gitHead });
const complete = (gitHead = HEAD) => ({ status: "complete", gitHead });

describe("computeCorpusDigest", () => {
	it("is stable under entry order", () => {
		const a = [
			{ rel: "openwiki/b.md", content: "B" },
			{ rel: "openwiki/a.md", content: "A" },
		];
		const b = [
			{ rel: "openwiki/a.md", content: "A" },
			{ rel: "openwiki/b.md", content: "B" },
		];
		assert.equal(computeCorpusDigest(a), computeCorpusDigest(b));
	});

	it("changes when any page content changes", () => {
		const before = [{ rel: "openwiki/a.md", content: "A" }];
		const after = [{ rel: "openwiki/a.md", content: "A!" }];
		assert.notEqual(computeCorpusDigest(before), computeCorpusDigest(after));
	});

	it("changes when a page is added or renamed", () => {
		const base = [{ rel: "openwiki/a.md", content: "A" }];
		const added = [...base, { rel: "openwiki/b.md", content: "" }];
		const renamed = [{ rel: "openwiki/c.md", content: "A" }];
		assert.notEqual(computeCorpusDigest(base), computeCorpusDigest(added));
		assert.notEqual(computeCorpusDigest(base), computeCorpusDigest(renamed));
	});

	it("cannot be spoofed by moving content across a page boundary", () => {
		const split = [
			{ rel: "openwiki/a.md", content: "one" },
			{ rel: "openwiki/b.md", content: "two" },
		];
		const merged = [
			{ rel: "openwiki/a.md", content: "onetwo" },
			{ rel: "openwiki/b.md", content: "" },
		];
		assert.notEqual(computeCorpusDigest(split), computeCorpusDigest(merged));
	});

	it("is a namespaced sha256 hex string", () => {
		assert.match(computeCorpusDigest([{ rel: "a", content: "b" }]), /^sha256:[0-9a-f]{64}$/);
	});
});

describe("evaluateFreshness: interrupted corpus", () => {
	it("fails when no manual-review record exists, even at the current HEAD", () => {
		const { problems } = evaluateFreshness({
			state: interrupted(HEAD),
			head: HEAD,
			review: null,
			corpusDigest: DIGEST_A,
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /manual-review\.json/);
	});

	it("fails when the review record covers a different corpus", () => {
		const { problems } = evaluateFreshness({
			state: interrupted(),
			head: HEAD,
			review: { corpusDigest: DIGEST_B },
			corpusDigest: DIGEST_A,
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /different corpus|re-review/);
	});

	it("fails when the review record declares no digest", () => {
		for (const review of [{}, { corpusDigest: "" }, { corpusDigest: 42 }]) {
			const { problems } = evaluateFreshness({
				state: interrupted(),
				head: HEAD,
				review,
				corpusDigest: DIGEST_A,
			});
			assert.equal(problems.length, 1, JSON.stringify(review));
			assert.match(problems[0], /corpusDigest/);
		}
	});

	it("passes when a review record binds to this exact corpus", () => {
		const { problems } = evaluateFreshness({
			state: interrupted(),
			head: HEAD,
			review: { corpusDigest: DIGEST_A, reviewedAt: "2026-08-28T00:00:00Z" },
			corpusDigest: DIGEST_A,
		});
		assert.deepEqual(problems, []);
	});

	it("passes a reviewed corpus after HEAD moves, but warns that code drifted", () => {
		const { problems, warnings } = evaluateFreshness({
			state: interrupted(OLD_HEAD),
			head: HEAD,
			review: { corpusDigest: DIGEST_A, gitHead: OLD_HEAD },
			corpusDigest: DIGEST_A,
		});
		assert.deepEqual(problems, []);
		assert.ok(
			warnings.some((w) => /moved since the review/.test(w)),
			`expected a drift warning, got ${JSON.stringify(warnings)}`,
		);
	});
});

describe("evaluateFreshness: other states", () => {
	it("accepts a completed corpus and warns only when HEAD moved", () => {
		assert.deepEqual(evaluateFreshness({ state: complete(HEAD), head: HEAD, review: null }).warnings, []);
		const moved = evaluateFreshness({ state: complete(OLD_HEAD), head: HEAD, review: null });
		assert.deepEqual(moved.problems, []);
		assert.equal(moved.warnings.length, 1);
	});

	it("never requires a review record for a completed corpus", () => {
		const { problems } = evaluateFreshness({
			state: complete(OLD_HEAD),
			head: HEAD,
			review: null,
			corpusDigest: DIGEST_A,
		});
		assert.deepEqual(problems, []);
	});

	it("rejects an unknown or missing status", () => {
		for (const state of [{ status: "partial", gitHead: HEAD }, { gitHead: HEAD }]) {
			const { problems } = evaluateFreshness({ state, head: HEAD, review: null, corpusDigest: DIGEST_A });
			assert.equal(problems.length, 1);
			assert.match(problems[0], /unknown status/);
		}
	});

	it("rejects a record with no gitHead anchor", () => {
		const { problems } = evaluateFreshness({
			state: { status: "interrupted" },
			head: HEAD,
			review: { corpusDigest: DIGEST_A },
			corpusDigest: DIGEST_A,
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /gitHead missing/);
	});

	it("skips the HEAD comparison outside a git checkout", () => {
		const { problems, warnings } = evaluateFreshness({
			state: complete(OLD_HEAD),
			head: null,
			review: null,
			corpusDigest: DIGEST_A,
		});
		assert.deepEqual(problems, []);
		assert.deepEqual(warnings, []);
	});
});

/**
 * Spec 014 security blocker 2: symbol checks used global substring presence, so
 * any invented identifier passed as long as those characters appeared anywhere
 * in the repository. A declared symbol must instead bind to one of the page's
 * own declared source paths.
 */
describe("evaluateSymbolBinding", () => {
	const reader = (files) => (path) => files[path] ?? null;

	it("binds a symbol that really is declared in a declared source path", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["AgentSession"],
			sourcePaths: ["src/a.ts"],
			readSource: reader({ "src/a.ts": "export class AgentSession {}" }),
		});
		assert.deepEqual(problems, []);
	});

	it("rejects a symbol that exists elsewhere but not in the declared paths", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["AgentLoop"],
			sourcePaths: ["package.json"],
			readSource: reader({ "package.json": '{"name":"omk-monorepo"}' }),
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /AgentLoop/);
		assert.match(problems[0], /package\.json/);
	});

	it("requires a whole-identifier match, not a substring", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["Agent"],
			sourcePaths: ["src/a.ts"],
			readSource: reader({ "src/a.ts": "export class AgentSessionManager {}" }),
		});
		assert.equal(problems.length, 1, "`Agent` must not bind to `AgentSessionManager`");
	});

	it("accepts a symbol found in any one of several declared paths", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["stream"],
			sourcePaths: ["src/a.ts", "src/b.ts"],
			readSource: reader({ "src/a.ts": "nothing", "src/b.ts": "export function stream() {}" }),
		});
		assert.deepEqual(problems, []);
	});

	it("reports a declared source path that does not exist", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["X"],
			sourcePaths: ["src/gone.ts"],
			readSource: reader({}),
		});
		assert.ok(problems.some((p) => /src\/gone\.ts/.test(p) && /does not exist/.test(p)));
	});

	it("refuses symbols declared with no source path to bind to", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["Whatever"],
			sourcePaths: [],
			readSource: reader({}),
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /source_paths/);
	});

	it("handles identifiers containing regex metacharacters literally", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["check:constitution", "check-release-consistency"],
			sourcePaths: ["package.json"],
			readSource: reader({ "package.json": '"check:constitution": "node check-release-consistency.mjs"' }),
		});
		assert.deepEqual(problems, []);
	});

	it("accepts a symbol that names a declared path itself, with or without extension", () => {
		for (const symbol of ["check-release-consistency", "check-release-consistency.mjs"]) {
			assert.deepEqual(
				evaluateSymbolBinding({
					rel: "openwiki/p.md",
					symbols: [symbol],
					sourcePaths: ["scripts/check-release-consistency.mjs"],
					readSource: reader({ "scripts/check-release-consistency.mjs": "// no self reference" }),
				}),
				[],
				symbol,
			);
		}
	});

	it("does not let a path name excuse an unrelated symbol on the same page", () => {
		const problems = evaluateSymbolBinding({
			rel: "openwiki/p.md",
			symbols: ["check:constitution"],
			sourcePaths: ["scripts/check-release-consistency.mjs"],
			readSource: reader({ "scripts/check-release-consistency.mjs": "// no self reference" }),
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /check:constitution/);
	});

	it("says nothing when a page declares no symbols", () => {
		assert.deepEqual(
			evaluateSymbolBinding({ rel: "openwiki/p.md", symbols: [], sourcePaths: [], readSource: reader({}) }),
			[],
		);
	});
});

describe("runGate: absent corpus", () => {
	/**
	 * The corpus is worktree-only and regenerated by CI. Treating its absence as a
	 * hard failure made every commit depend on generated scratch content that is
	 * in no commit — and a corpus that does not exist cannot mislead a reader.
	 */
	it("reports an absent corpus as a warning, not a failure", () => {
		const { problems, warnings, pageCount } = runGate("/nonexistent/openwiki");
		assert.deepEqual(problems, []);
		assert.equal(pageCount, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /absent/);
	});
});

describe("repository state", () => {
	it("holds a corpus whose manual-review record still matches", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		const { join, resolve, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
		const statePath = join(repoRoot, "openwiki", ".last-update.json");
		if (!existsSync(statePath)) return; // corpus is worktree-only; nothing to assert

		const state = JSON.parse(readFileSync(statePath, "utf8"));
		if (state.status !== "interrupted") return;

		const reviewPath = join(repoRoot, "openwiki", ".manual-review.json");
		assert.ok(existsSync(reviewPath), "an interrupted corpus must carry a manual-review record");
		const { collectCorpus } = await import("../check-openwiki.mjs");
		const review = JSON.parse(readFileSync(reviewPath, "utf8"));
		assert.equal(
			review.corpusDigest,
			computeCorpusDigest(collectCorpus()),
			"review record no longer covers the corpus on disk",
		);
	});
});
