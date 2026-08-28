import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The skill and the extension are a pair: the extension's only job is to send
 * `!skill:cli-anything` with a target attached, so a rename on either side
 * silently turns every command into a no-op that looks like it worked.
 *
 * `.omk/extensions/**` sits outside the root tsconfig `include`, so these files
 * are not covered by `tsgo --noEmit`. This suite runs under `check:constitution`,
 * which is part of `npm run check`, and is therefore the only gate that sees them.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillPath = join(repoRoot, ".omk/skills/cli-anything/SKILL.md");
const extensionDir = join(repoRoot, ".omk/extensions/cli-anything");
const indexPath = join(extensionDir, "index.ts");

describe("cli-anything skill", () => {
	const skill = readFileSync(skillPath, "utf8");

	it("declares the name the extension invokes", () => {
		assert.match(skill, /^---\n(?:.*\n)*?name: cli-anything\n/);
	});

	it("carries a description, which is what selects it for a task", () => {
		const description = skill.match(/\ndescription: (.+)\n/);
		assert.ok(description, "frontmatter must declare a description");
		assert.ok(description[1].length > 80, "a one-line description will not match real tasks");
	});

	it("keeps the rule that decides whether a harness is useful", () => {
		// A harness that quietly falls back to a lookalike renderer reports success
		// while producing wrong output, which is worse than failing.
		assert.match(skill, /hard dependency/i);
		assert.match(skill, /fall back|fallback/i);
	});

	it("attributes upstream, since the methodology is Apache-2.0", () => {
		assert.match(skill, /HKUDS\/CLI-Anything/);
		assert.match(skill, /Apache-2\.0/);
	});

	it("does not vendor the upstream specification", () => {
		// Upstream's HARNESS.md is ~750 lines. A copy would carry attribution
		// obligations into an MIT repository and drift from upstream.
		assert.ok(skill.split("\n").length < 200, "the skill should summarize upstream, not copy it");
	});
});

describe("cli-anything extension", () => {
	const index = readFileSync(indexPath, "utf8");

	it("imports the OMK extension API, not upstream Pi's", () => {
		assert.match(index, /from "open-multi-agent-kit"/);
		assert.doesNotMatch(index, /@mariozechner\/pi-coding-agent/);
	});

	it("sends the skill the extension is paired with", () => {
		assert.match(index, /const SKILL = "cli-anything"/);
		assert.match(index, /`!skill:\$\{SKILL\}`/);
	});

	it("registers every documented command", () => {
		for (const name of ["cli-anything", "cli-anything:refine", "cli-anything:test"]) {
			assert.ok(index.includes(`name: "${name}"`), `missing command ${name}`);
		}
	});

	it("refuses an empty target instead of sending a message with none", () => {
		assert.match(index, /if \(!target\) \{\s*\n\s*ctx\.ui\.notify\(spec\.usage, "warning"\);\s*\n\s*return;/);
	});

	it("delivers through the API, since the command context has no sender", () => {
		// ExtensionCommandContext carries the UI; sendUserMessage lives on ExtensionAPI.
		assert.match(index, /omk\.sendUserMessage\(/);
		assert.doesNotMatch(index, /ctx\.sendUserMessage\(/);
	});

	it("declares itself loadable", () => {
		const pkg = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
		assert.deepEqual(pkg.omk?.extensions, ["./index.ts"]);
		assert.equal(pkg.private, true, "a repository-local extension must not be publishable");
	});

	it("ships a tsconfig, because the root typecheck does not reach it", () => {
		const tsconfig = JSON.parse(readFileSync(join(extensionDir, "tsconfig.json"), "utf8"));
		assert.equal(tsconfig.compilerOptions?.noEmit, true);
		assert.ok(existsSync(join(repoRoot, "tsconfig.base.json")), "tsconfig.base.json must exist to extend");
	});
});

describe("cli-anything catalog entry", () => {
	it("is listed in the public skill catalog", () => {
		const catalog = readFileSync(join(repoRoot, "SKILLS.md"), "utf8");
		assert.match(catalog, /\[`cli-anything`\]\(\.omk\/skills\/cli-anything\/SKILL\.md\)/);
	});
});
