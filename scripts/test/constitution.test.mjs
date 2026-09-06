/**
 * Constitution-as-tests: specs/constitution.md policies that are enforced by
 * code must stay enforced. If one of these tests fails, either the policy or
 * the enforcement drifted — reconcile before releasing.
 *
 * Run: node --test scripts/test/
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseScriptPath = join(root, "scripts", "release.mjs");

function readFileOrThrow(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(
			`constitution test cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function readJsonOrThrow(path) {
	try {
		return JSON.parse(readFileOrThrow(path));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("constitution test")) throw error;
		throw new Error(`constitution test cannot parse ${path}: ${error.message}`);
	}
}

const releaseSource = readFileOrThrow(releaseScriptPath);
const packageJson = readJsonOrThrow(join(root, "package.json"));
const constitution = readFileOrThrow(join(root, "specs", "constitution.md"));

function runReleaseCli(arg) {
	return spawnSync(process.execPath, [releaseScriptPath, arg], { encoding: "utf8" });
}

describe("constitution: no major releases", () => {
	it("specs/constitution.md declares the policy", () => {
		assert.match(constitution, /no major releases/i);
	});

	it("release.mjs rejects `major` before any side effect", () => {
		const result = runReleaseCli("major");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /major releases are not allowed/);
	});

	it("release.mjs rejects unknown and missing targets with usage", () => {
		for (const arg of ["banana", undefined]) {
			const result = runReleaseCli(arg);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Usage:/);
		}
	});

	it("isMajorBump flags major jumps only", async () => {
		const { isMajorBump } = await import(releaseScriptPath);
		assert.equal(isMajorBump("1.0.0", "0.96.2"), true);
		assert.equal(isMajorBump("0.97.0", "0.96.2"), false);
		assert.equal(isMajorBump("0.96.3", "0.96.2"), false);
	});

	it("package.json exposes no major bump entry points", () => {
		const scripts = Object.keys(packageJson.scripts ?? {});
		for (const banned of ["version:major", "release:major"]) {
			assert.equal(
				scripts.includes(banned),
				false,
				`package.json must not expose "${banned}" (constitution: no major releases)`,
			);
		}
	});
});

describe("constitution: releases run on the release branch", () => {
	it("release.mjs pins the release branch to main", () => {
		assert.match(releaseSource, /RELEASE_BRANCH\s*=\s*"main"/);
		assert.match(releaseSource, /HEAD is detached|Releases must run on/);
	});
});

describe("constitution: public lockstep packages", () => {
	it("lists all seven public packages including omk-adaptorch-wpl", () => {
		for (const name of [
			"open-multi-agent-kit",
			"omk-ai",
			"omk-agent-core",
			"omk-tui",
			"omk-protocol",
			"omk-adaptorch-wpl",
			"omk-book-to-skill",
		]) {
			assert.match(constitution, new RegExp(`\\\`${name}\\\``), `missing ${name}`);
		}
	});

	it("publish helper covers exactly those seven packages", async () => {
		const publishSource = readFileSync(join(root, "scripts", "publish.mjs"), "utf8");
		for (const name of [
			"open-multi-agent-kit",
			"omk-ai",
			"omk-agent-core",
			"omk-tui",
			"omk-protocol",
			"omk-adaptorch-wpl",
			"omk-book-to-skill",
		]) {
			assert.match(publishSource, new RegExp(`"${name}"`), `publish.mjs missing ${name}`);
		}
	});
});

describe("constitution: CI-only npm publishing", () => {
	it("declares the actual CI publication path without inventing OIDC provenance", () => {
		assert.match(constitution, /`build-binaries\.yml`, `publish-npm` job, environment `npm-publish`/);
		assert.match(constitution, /currently uses.*`NPM_TOKEN`/);
		assert.match(constitution, /OIDC trusted publishing.*not currently enabled/);
		const workflow = readFileOrThrow(join(root, ".github", "workflows", "build-binaries.yml"));
		const publishJob = workflow.slice(workflow.indexOf("  publish-npm:"));
		assert.match(publishJob, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
		assert.doesNotMatch(publishJob, /^\s+id-token: write\s*$/m);
	});
});

describe("repo hygiene: no backup files in source trees", () => {
	it("packages/*/src contains no .bak or editor-swap leftovers", () => {
		const offenders = [];
		for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const srcDir = join(root, "packages", entry.name, "src");
			if (!existsSync(srcDir)) continue;
			const stack = [srcDir];
			while (stack.length > 0) {
				const dir = stack.pop();
				for (const item of readdirSync(dir, { withFileTypes: true })) {
					const full = join(dir, item.name);
					if (item.isDirectory()) stack.push(full);
					else if (/\.(bak|bak-[\w-]+|orig|rej)$|~$/.test(item.name)) offenders.push(full.slice(root.length + 1));
				}
			}
		}
		assert.deepEqual(offenders, [], "remove backup files from source trees (git history keeps them)");
	});
});
