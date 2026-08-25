/**
 * Constitution-as-tests: specs/constitution.md → "Owner-Private Agent Home".
 *
 * The guard's logic is tested against injected data; the repository state is then tested
 * against the real tree, so a private artifact committed tomorrow fails here.
 *
 * Run: node --test scripts/test/
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	findDuplicates,
	findMarkerHits,
	findTrackedArtifacts,
	findUnignoredArtifacts,
	MARKER_ALLOWLIST,
	PRIVATE_ARTIFACTS,
	PRIVATE_DOC_PATTERN,
	STACK_MARKERS,
} from "../check-private-agent-home.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardPath = join(root, "scripts", "check-private-agent-home.mjs");
const constitution = readFileSync(join(root, "specs", "constitution.md"), "utf8");

describe("constitution: owner-private agent home", () => {
	it("declares the boundary and names its enforcement", () => {
		assert.match(constitution, /## Owner-Private Agent Home/);
		assert.match(constitution, /scripts\/check-private-agent-home\.mjs/);
	});

	it("covers the artifacts that have actually leaked before", () => {
		for (const artifact of ["AGENTS.GODMODE.md", "AGENTS.override.md", ".agents/"]) {
			assert.ok(PRIVATE_ARTIFACTS.includes(artifact), `PRIVATE_ARTIFACTS missing ${artifact}`);
		}
	});
});

describe("findUnignoredArtifacts", () => {
	it("returns only the artifacts git does not ignore", () => {
		const ignored = new Set([".gjc/"]);
		assert.deepEqual(findUnignoredArtifacts([".gjc/", "AGENTS.stub.md"], (p) => ignored.has(p)), [
			"AGENTS.stub.md",
		]);
	});
});

describe("findTrackedArtifacts", () => {
	it("flattens every tracked file under a private path", () => {
		const tracked = { ".agents/": [".agents/a.md", ".agents/b.md"], "AGENTS.stub.md": [] };
		assert.deepEqual(findTrackedArtifacts([".agents/", "AGENTS.stub.md"], (p) => tracked[p] ?? []), [
			".agents/a.md",
			".agents/b.md",
		]);
	});
});

describe("findMarkerHits", () => {
	const read = (file) => ({ "a.md": "uses godmode.unify( here", "b.md": "nothing private" })[file];

	it("finds a private marker and names it", () => {
		assert.deepEqual(findMarkerHits(["a.md", "b.md"], read), [{ file: "a.md", marker: "godmode.unify(" }]);
	});

	it("skips allowlisted files that quote the markers as data", () => {
		assert.deepEqual(findMarkerHits(["a.md"], read, STACK_MARKERS, new Set(["a.md"])), []);
	});

	it("ignores unreadable or binary files instead of throwing", () => {
		assert.deepEqual(findMarkerHits(["missing.bin"], () => undefined), []);
	});

	it("catches a drifted copy that no longer matches any digest", () => {
		const stale = "# AGENTS.md — OMK Operational Stack Map (v10.4-math)\nold body\n";
		assert.deepEqual(findMarkerHits(["AGENTS.md"], () => stale), [
			{ file: "AGENTS.md", marker: "Operational Stack Map" },
		]);
	});
});

describe("findDuplicates", () => {
	it("pairs a tracked file with the private document it copies", () => {
		const duplicates = findDuplicates(
			[
				["AGENTS.md", "deadbeef"],
				["README.md", "cafe"],
			],
			[["AGENTS.md", "deadbeef"]],
		);
		assert.deepEqual(duplicates, [{ file: "AGENTS.md", source: "AGENTS.md" }]);
	});

	it("reports nothing when no digest matches", () => {
		assert.deepEqual(findDuplicates([["README.md", "cafe"]], [["SOUL.md", "beef"]]), []);
	});
});

describe("PRIVATE_DOC_PATTERN", () => {
	it("matches the private root documents and not ordinary repo docs", () => {
		for (const name of ["AGENTS.md", "AGENTS.GODMODE.md", "SOUL.hard.md", "RED-TEAM-APPLIED.md"]) {
			assert.ok(PRIVATE_DOC_PATTERN.test(name), `should match ${name}`);
		}
		for (const name of ["README.md", "CHANGELOG.md", "notes.md"]) {
			assert.equal(PRIVATE_DOC_PATTERN.test(name), false, `should not match ${name}`);
		}
	});
});

describe("repository state", () => {
	it("passes the guard against the real tree", () => {
		const result = spawnSync(process.execPath, [guardPath], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	});

	it("keeps the marker allowlist to the guard and this test", () => {
		assert.deepEqual([...MARKER_ALLOWLIST].sort(), [
			"scripts/check-private-agent-home.mjs",
			"scripts/test/private-agent-home.test.mjs",
		]);
	});
});
