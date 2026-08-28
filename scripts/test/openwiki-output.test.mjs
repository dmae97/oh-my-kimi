import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	evaluateChangedPaths,
	findPrivatePathHits,
	findSecretHits,
	runOutputGate,
} from "../check-openwiki-output.mjs";

/**
 * Spec 014 security blockers 3 and 4.
 *
 * The OpenWiki generator is a model writing files into a checkout. Whatever it
 * may write, CI will then upload as an artifact and open a pull request for. If
 * that set includes `AGENTS.md`, `CLAUDE.md`, or the workflow that runs the
 * model, then repository content the model reads can rewrite the rules agents
 * follow, or the CI job itself. The output must be `openwiki/**` and nothing
 * else, checked before upload and again before the PR.
 */

describe("evaluateChangedPaths", () => {
	it("accepts generated pages and generator state", () => {
		const violations = evaluateChangedPaths([
			"openwiki/index.md",
			"openwiki/architecture/overview.md",
			"openwiki/.last-update.json",
		]);
		assert.deepEqual(violations, []);
	});

	it("accepts an empty change set, because a no-op run is not a fault", () => {
		assert.deepEqual(evaluateChangedPaths([]), []);
	});

	it("rejects the agent authority surfaces by name", () => {
		for (const path of ["AGENTS.md", "CLAUDE.md"]) {
			const violations = evaluateChangedPaths([path]);
			assert.equal(violations.length, 1, path);
			assert.match(violations[0], new RegExp(path));
		}
	});

	it("rejects the workflow that runs the generator", () => {
		const violations = evaluateChangedPaths([".github/workflows/openwiki-update.yml"]);
		assert.equal(violations.length, 1);
		assert.match(violations[0], /workflows/);
	});

	it("rejects source, config, and every other path outside the corpus", () => {
		const outside = ["package.json", "packages/coding-agent/src/main.ts", "scripts/check-openwiki.mjs", "LICENSE"];
		assert.equal(evaluateChangedPaths(outside).length, outside.length);
	});

	it("reports every violation rather than only the first", () => {
		const violations = evaluateChangedPaths(["AGENTS.md", "openwiki/a.md", "CLAUDE.md"]);
		assert.equal(violations.length, 2);
	});

	it("does not let a lookalike prefix pass as the corpus", () => {
		for (const path of ["openwiki-evil/a.md", "openwiki.md", "../openwiki/a.md", "/etc/passwd"]) {
			assert.equal(evaluateChangedPaths([path]).length, 1, path);
		}
	});

	it("rejects a traversal segment even under the corpus prefix", () => {
		assert.equal(evaluateChangedPaths(["openwiki/../AGENTS.md"]).length, 1);
	});

	it("normalises a leading ./ rather than rejecting it", () => {
		assert.deepEqual(evaluateChangedPaths(["./openwiki/index.md"]), []);
	});
});

describe("findPrivatePathHits", () => {
	const reader = (files) => (path) => files[path];

	it("finds an operator home directory in generated prose", () => {
		const hits = findPrivatePathHits(["openwiki/a.md"], reader({ "openwiki/a.md": "see /home/yu/projects/x" }));
		assert.equal(hits.length, 1);
		assert.match(hits[0], /openwiki\/a\.md/);
	});

	it("finds a Windows user path", () => {
		const hits = findPrivatePathHits(["a.md"], reader({ "a.md": "C:\\Users\\operator\\notes.md" }));
		assert.equal(hits.length, 1);
	});

	it("finds owner-private agent documents", () => {
		for (const text of ["AGENTS.GODMODE.md", "AGENTS.override.hard.md", "see .omo/evidence/x"]) {
			assert.equal(findPrivatePathHits(["a.md"], reader({ "a.md": text })).length, 1, text);
		}
	});

	it("stays quiet on ordinary repository paths", () => {
		const clean = "packages/coding-agent/src/main.ts and scripts/check-openwiki.mjs";
		assert.deepEqual(findPrivatePathHits(["a.md"], reader({ "a.md": clean })), []);
	});

	it("skips a file it cannot read instead of throwing", () => {
		assert.deepEqual(
			findPrivatePathHits(["gone.md"], () => {
				throw new Error("ENOENT");
			}),
			[],
		);
	});
});

/**
 * Fixtures are assembled at run time so no literal credential shape sits in this
 * file. These are synthetic, but a push-protection scanner matches the shape,
 * not the validity: the literal Slack fixture blocked this repository's release
 * push at the remote. Keeping them assembled lets the test still exercise every
 * pattern while the committed source stays free of anything a scanner will
 * flag.
 */
const FIXTURE = {
	anthropic: `sk-ant-${"api03"}-${"A".repeat(36)}`,
	github: `ghp${"_"}${"A".repeat(36)}`,
	githubOther: `ghp${"_"}${"B".repeat(36)}`,
	aws: `AKIA${"A".repeat(16)}`,
	slack: `xoxb-${"1".repeat(12)}-${"abcdefghijklmnopqrst"}`,
	privateKey: `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`,
};

describe("findSecretHits", () => {
	const reader = (files) => (path) => files[path];

	it("finds credential shapes a generator could quote out of a checkout", () => {
		const cases = [
			FIXTURE.anthropic,
			FIXTURE.github,
			FIXTURE.aws,
			FIXTURE.slack,
			FIXTURE.privateKey,
		];
		for (const text of cases) {
			assert.equal(findSecretHits(["a.md"], reader({ "a.md": text })).length, 1, text);
		}
	});

	it("names the file so a reviewer can find it", () => {
		const hits = findSecretHits(["openwiki/a.md"], reader({ "openwiki/a.md": FIXTURE.github }));
		assert.match(hits[0], /openwiki\/a\.md/);
	});

	it("never echoes the matched credential", () => {
		const secret = FIXTURE.githubOther;
		const hits = findSecretHits(["a.md"], reader({ "a.md": secret }));
		assert.equal(hits.length, 1);
		assert.ok(!hits[0].includes(secret), `hit must not quote the secret: ${hits[0]}`);
	});

	it("stays quiet on ordinary documentation prose", () => {
		const clean = "Set ANTHROPIC_API_KEY in your environment, then run npm run check.";
		assert.deepEqual(findSecretHits(["a.md"], reader({ "a.md": clean })), []);
	});
});

describe("runOutputGate", () => {
	const reader = (files) => (path) => files[path];

	it("passes a clean generated corpus", () => {
		const result = runOutputGate({
			changedPaths: ["openwiki/index.md"],
			readContent: reader({ "openwiki/index.md": "# Index" }),
		});
		assert.deepEqual(result.problems, []);
	});

	it("fails closed on an escaped path and names it", () => {
		const result = runOutputGate({
			changedPaths: ["openwiki/index.md", "AGENTS.md"],
			readContent: reader({ "openwiki/index.md": "# Index", "AGENTS.md": "# Agents" }),
		});
		assert.equal(result.problems.length, 1);
		assert.match(result.problems[0], /AGENTS\.md/);
	});

	it("reports a leaked credential in the corpus", () => {
		const result = runOutputGate({
			changedPaths: ["openwiki/a.md"],
			readContent: reader({ "openwiki/a.md": "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
		});
		assert.equal(result.problems.length, 1);
		assert.match(result.problems[0], /secret/i);
	});

	it("reports a private path even when every changed file is in the corpus", () => {
		const result = runOutputGate({
			changedPaths: ["openwiki/a.md"],
			readContent: reader({ "openwiki/a.md": "built at /home/yu/omk" }),
		});
		assert.equal(result.problems.length, 1);
		assert.match(result.problems[0], /private/i);
	});

	it("scans only files inside the corpus, since the rest are already rejected", () => {
		const read = [];
		runOutputGate({
			changedPaths: ["openwiki/a.md", "AGENTS.md"],
			readContent: (path) => {
				read.push(path);
				return "";
			},
		});
		assert.deepEqual(read, ["openwiki/a.md"]);
	});
});
