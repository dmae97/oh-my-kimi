import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ciEnv = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "tok" };

describe("publish.mjs provenance resolution", () => {
	it("imports without side effects and exports helpers", async () => {
		const mod = await import(join(root, "scripts", "publish.mjs"));
		assert.equal(typeof mod.resolveProvenance, "function");
		assert.equal(typeof mod.provenanceSupported, "function");
	});

	it("is off locally and on in GitHub Actions", async () => {
		const { resolveProvenance } = await import(join(root, "scripts", "publish.mjs"));
		assert.equal(resolveProvenance([], {}), false);
		assert.equal(resolveProvenance([], ciEnv), true);
	});

	it("flags override auto-detection in both directions", async () => {
		const { resolveProvenance } = await import(join(root, "scripts", "publish.mjs"));
		assert.equal(resolveProvenance(["--no-provenance"], ciEnv), false);
		assert.equal(resolveProvenance(["--provenance"], {}), true);
	});
});

describe("release.mjs preflight and README sync", () => {
	it("computes target versions for bump types and explicit versions", async () => {
		const { computeTargetVersion } = await import(join(root, "scripts", "release.mjs"));
		assert.equal(computeTargetVersion("minor", "0.97.0"), "0.98.0");
		assert.equal(computeTargetVersion("patch", "0.97.0"), "0.97.1");
		assert.equal(computeTargetVersion("0.99.3", "0.97.0"), "0.99.3");
	});

	it("detects existing and missing release notes", async () => {
		const { releaseNotesExist } = await import(join(root, "scripts", "release.mjs"));
		assert.equal(releaseNotesExist("0.97.0", root), true);
		assert.equal(releaseNotesExist("9.99.9", root), false);
	});

	it("updates coding-agent README version references", async () => {
		const { updateCodingAgentReadme } = await import(join(root, "scripts", "release.mjs"));
		const dir = mkdtempSync(join(tmpdir(), "omk-release-readme-"));
		const fixture = join(dir, "README.md");
		writeFileSync(
			fixture,
			[
				"omk install npm:omk-book-to-skill@0.97.0",
				"Release notes: [v0.97.0](https://github.com/dmae97/omk/blob/main/.github/RELEASE_NOTES_v0.97.0.md).",
			].join("\n"),
		);
		try {
			updateCodingAgentReadme("0.98.0", fixture);
			const text = readFileSync(fixture, "utf8");
			assert.match(text, /npm:omk-book-to-skill@0\.98\.0/);
			assert.match(text, /RELEASE_NOTES_v0\.98\.0\.md/);
			assert.doesNotMatch(text, /0\.97\.0/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
