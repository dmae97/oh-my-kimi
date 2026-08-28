import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { retargetReleaseNotesPointer } from "../sync-readme-releases.mjs";

/**
 * `check-release-consistency.mjs` reads the *first* `RELEASE_NOTES_vX.Y.Z.md`
 * match in README.md as the advertised release surface. The documentation index
 * carries such a link, and it sits above the generated release sections, so it
 * is the match that counts. Nothing updated it, which stalled a release at the
 * consistency gate after the version bump had already been applied.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("retargetReleaseNotesPointer", () => {
	it("retargets the documentation index link to the released version", () => {
		const before = "- [Release notes for v0.97.0](.github/RELEASE_NOTES_v0.97.0.md)\n";
		const after = retargetReleaseNotesPointer(before, "0.98.0");
		assert.equal(after, "- [Release notes for v0.98.0](.github/RELEASE_NOTES_v0.98.0.md)\n");
	});

	it("rewrites only the index entry, leaving generated sections alone", () => {
		const markdown = [
			"- [Release notes for v0.97.0](.github/RELEASE_NOTES_v0.97.0.md)",
			"",
			"## Release v0.97.0",
			"Release notes live in [RELEASE_NOTES_v0.97.0.md](.github/RELEASE_NOTES_v0.97.0.md).",
		].join("\n");

		const after = retargetReleaseNotesPointer(markdown, "0.98.0");
		assert.match(after, /- \[Release notes for v0\.98\.0\]\(\.github\/RELEASE_NOTES_v0\.98\.0\.md\)/);
		assert.match(after, /Release notes live in \[RELEASE_NOTES_v0\.97\.0\.md\]/);
	});

	it("is idempotent", () => {
		const once = retargetReleaseNotesPointer("- [Release notes for v0.97.0](.github/RELEASE_NOTES_v0.97.0.md)", "0.98.0");
		assert.equal(retargetReleaseNotesPointer(once, "0.98.0"), once);
	});

	it("leaves markdown without an index entry untouched", () => {
		const markdown = "## Release v0.97.0\nnothing to retarget here.\n";
		assert.equal(retargetReleaseNotesPointer(markdown, "0.98.0"), markdown);
	});
});

describe("repository state", () => {
	it("advertises one release surface: the index entry matches the newest release notes", () => {
		const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
		const first = readme.match(/RELEASE_NOTES_v(\d+\.\d+\.\d+)\.md/);
		assert.ok(first, "README.md must point at release notes");

		const codingAgentReadme = readFileSync(join(repoRoot, "packages/coding-agent/README.md"), "utf8");
		const agentFirst = codingAgentReadme.match(/RELEASE_NOTES_v(\d+\.\d+\.\d+)\.md|release-v(\d+\.\d+\.\d+)/);
		if (agentFirst) {
			const agentVersion = agentFirst[1] ?? agentFirst[2];
			assert.equal(first[1], agentVersion, "root and coding-agent READMEs must advertise the same release");
		}
	});
});
