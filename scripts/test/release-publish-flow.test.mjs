import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * The release used to regenerate the model catalogs from live provider APIs, so
 * the shipped artifact depended on which endpoints answered the machine cutting
 * the release. One attempt dropped 26 of 57 Cloudflare models and 32 OpenRouter
 * models, which then failed typecheck against model ids the tests reference.
 * Release output must be a function of the committed tree, not network weather.
 */
describe("release artifacts do not depend on live provider APIs", () => {
	const releaseSource = readFileSync(join(root, "scripts", "release.mjs"), "utf8");

	it("does not regenerate the model catalogs during a release", () => {
		assert.doesNotMatch(releaseSource, /run\(\s*["'`][^"'`]*generate-models/);
		assert.doesNotMatch(releaseSource, /run\(\s*["'`][^"'`]*generate-image-models/);
	});

	it("still produces the deterministic shrinkwrap artifact", () => {
		assert.match(releaseSource, /shrinkwrap:coding-agent/);
	});

	it("exposes catalog refresh as its own reviewed step", () => {
		const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		assert.ok(scripts["models:refresh"], "root package.json must expose models:refresh");
		assert.match(scripts["models:refresh"], /generate-models/);
		assert.match(scripts["models:refresh"], /generate-image-models/);
	});

	it("prunes workspace copies that shadow the workspace links before checking", async () => {
		// `npm version --workspaces` plus `npm install --package-lock-only` leaves a
		// nested packages/<pkg>/node_modules/<workspace-pkg> directory pinned at the
		// pre-bump version, and `npm install` does not prune it. The stale copy
		// shadows the workspace link, so check:dep-tree failed the release after the
		// bump had already been written to every package.json.
		const { findShadowedWorkspaceCopies } = await import(join(root, "scripts", "release.mjs"));
		assert.equal(typeof findShadowedWorkspaceCopies, "function");

		const dir = mkdtempSync(join(tmpdir(), "omk-shadow-"));
		try {
			const pkgDir = join(dir, "packages", "agent");
			mkdirSync(join(pkgDir, "node_modules", "omk-ai"), { recursive: true });
			mkdirSync(join(dir, "packages", "ai"), { recursive: true });
			writeFileSync(join(dir, "packages", "ai", "package.json"), JSON.stringify({ name: "omk-ai" }));
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "omk-agent-core" }));

			const found = findShadowedWorkspaceCopies(dir);
			assert.deepEqual(found, [join(pkgDir, "node_modules", "omk-ai")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a workspace symlink alone, since that is the correct link", async () => {
		const { findShadowedWorkspaceCopies } = await import(join(root, "scripts", "release.mjs"));
		const dir = mkdtempSync(join(tmpdir(), "omk-shadow-link-"));
		try {
			mkdirSync(join(dir, "packages", "ai"), { recursive: true });
			writeFileSync(join(dir, "packages", "ai", "package.json"), JSON.stringify({ name: "omk-ai" }));
			const nodeModules = join(dir, "packages", "agent", "node_modules");
			mkdirSync(nodeModules, { recursive: true });
			writeFileSync(join(dir, "packages", "agent", "package.json"), JSON.stringify({ name: "omk-agent-core" }));
			symlinkSync(join(dir, "packages", "ai"), join(nodeModules, "omk-ai"), "dir");

			assert.deepEqual(findShadowedWorkspaceCopies(dir), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the generated catalogs committed so a release can read them", () => {
		for (const artifact of ["src/models.generated.ts", "src/image-models.generated.ts"]) {
			assert.ok(
				existsSync(join(root, "packages", "ai", artifact)),
				`${artifact} must be committed, not produced at release time`,
			);
		}
	});
});
