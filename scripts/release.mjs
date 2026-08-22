#!/usr/bin/env node
/**
 * Release script for OMK
 *
 * Usage:
 *   node scripts/release.mjs <minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Policy: there are no major releases (specs/constitution.md).
 *
 * Steps:
 * 1. Check the release branch and for uncommitted changes
 * 2. Bump version via npm run version:xxx or set an explicit version
 * 3. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 4. Regenerate release artifacts
 * 5. Run checks
 * 6. Commit and tag the release
 * 7. Add new [Unreleased] section to changelogs
 * 8. Commit next-cycle changelog updates
 * 9. Push main and the tag to trigger CI publishing
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

/**
 * Constitution guards live here so tests (scripts/test/) can import them.
 * Policy: there are no major releases; releases run only on RELEASE_BRANCH.
 */
export const BUMP_TYPES = new Set(["minor", "patch"]);
export const RELEASE_BRANCH = "main";

export function isMajorBump(target, current) {
	return Number(target.split(".")[0]) !== Number(current.split(".")[0]);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

const RELEASE_TARGET = process.argv[2];
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (isMain) {
	if (RELEASE_TARGET === "major") {
		console.error("Error: major releases are not allowed (specs/constitution.md). Use minor or patch.");
		process.exit(1);
	}

	if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
		console.error("Usage: node scripts/release.mjs <minor|patch|x.y.z>");
		process.exit(1);
	}
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	try {
		const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
		if (typeof pkg?.version !== "string" || !SEMVER_RE.test(pkg.version)) {
			throw new Error("missing or invalid semantic version");
		}
		return pkg.version;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: unable to read packages/ai/package.json: ${message}`);
		process.exit(1);
	}
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		return getVersion();
	}

	if (compareVersions(target, currentVersion) <= 0) {
		console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}

	if (isMajorBump(target, currentVersion)) {
		console.error(
			`Error: ${target} is a major bump from ${currentVersion}; major releases are not allowed (specs/constitution.md).`,
		);
		process.exit(1);
	}

	console.log(`Setting explicit version (${target})...`);
	run(
		`npm version ${target} --workspaces --include-workspace-root --no-git-tag-version && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`,
	);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow (only when invoked directly; importers get the exported guards)
if (isMain) {
console.log("\n=== Release Script ===\n");

// 1. Check the release branch and for uncommitted changes
console.log(`Checking the release branch (${RELEASE_BRANCH})...`);
const currentBranch = (run("git rev-parse --abbrev-ref HEAD", { silent: true }) || "").trim();
if (currentBranch !== RELEASE_BRANCH) {
	console.error(
		currentBranch === "HEAD"
			? `Error: HEAD is detached. Release commits and tags must be created on ${RELEASE_BRANCH}.`
			: `Error: on branch '${currentBranch}'. Releases must run on ${RELEASE_BRANCH}.`,
	);
	process.exit(1);
}
console.log(`  On ${RELEASE_BRANCH}\n`);

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 3. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
run("node scripts/check-release-consistency.mjs --release");
console.log();

// 4. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm --prefix packages/ai run generate-models");
run("npm --prefix packages/ai run generate-image-models");
run("npm run shrinkwrap:coding-agent");
run("node scripts/sync-readme-releases.mjs");
console.log();

// 5. Run checks
console.log("Running checks...");
run("npm run check");
console.log();

// 6. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 7. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 8. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 9. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Prepared release v${version}; CI publishing starts after the tag push ===`);
}
