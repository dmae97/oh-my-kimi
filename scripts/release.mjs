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
import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, readlinkSync, rmSync } from "fs";
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

/**
 * Physical copies of workspace packages that shadow the workspace links.
 *
 * `npm version --workspaces` followed by `npm install --package-lock-only`
 * leaves a nested `packages/<pkg>/node_modules/<workspace-pkg>` directory
 * pinned at the pre-bump version. A plain `npm install` does not prune it, so
 * the stale copy survives and breaks reference identity between the two copies
 * of the same package — failing `check:dep-tree` after the bump has already
 * been written to every package.json. A symlink here is the correct workspace
 * link and is left alone; only a real directory is a shadow.
 */
export function findShadowedWorkspaceCopies(repoRoot = ".") {
	const packagesDir = join(repoRoot, "packages");
	if (!existsSync(packagesDir)) return [];

	const packageDirs = readdirSync(packagesDir).filter((dir) =>
		existsSync(join(packagesDir, dir, "package.json")),
	);
	const workspaceNames = new Set();
	for (const dir of packageDirs) {
		const { name } = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
		if (name) workspaceNames.add(name);
	}

	const shadowed = [];
	for (const dir of packageDirs) {
		const nodeModules = join(packagesDir, dir, "node_modules");
		if (!existsSync(nodeModules)) continue;
		for (const name of workspaceNames) {
			const candidate = join(nodeModules, name);
			if (!existsSync(candidate) && !isSymlink(candidate)) continue;
			if (isSymlink(candidate)) continue;
			shadowed.push(candidate);
		}
	}
	return shadowed.sort();
}

function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Drop `.bin` entries left dangling by a pruned copy; a dangling link fails the same gate. */
function removeDanglingBinLinks(binDir) {
	if (!existsSync(binDir)) return;
	for (const entry of readdirSync(binDir)) {
		const link = join(binDir, entry);
		if (!isSymlink(link)) continue;
		if (existsSync(join(binDir, readlinkSync(link)))) continue;
		rmSync(link, { force: true });
	}
}

/**
 * Rebuild `node_modules` after a bump.
 *
 * The version scripts run `npm install --package-lock-only`, which updates the
 * lockfile but leaves stale physical copies behind. Prune those first, because
 * `npm install` adds and updates but does not remove them, then install so the
 * checks run against what the release actually is.
 */
function syncWorkspaceTree() {
	console.log("Rebuilding node_modules for the bumped versions...");
	for (const shadowed of findShadowedWorkspaceCopies(".")) {
		console.log(`  Pruning shadowed copy: ${shadowed}`);
		rmSync(shadowed, { recursive: true, force: true });
		removeDanglingBinLinks(join(shadowed, "..", ".bin"));
	}
	run("npm install --ignore-scripts");
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		syncWorkspaceTree();
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
	syncWorkspaceTree();
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

export function releaseNotesExist(version, root = ".") {
	return existsSync(join(root, ".github", `RELEASE_NOTES_v${version}.md`));
}

// packages/coding-agent/README.md carries two versioned references that must move
// with every release: the release-notes link and the install example pin.
export function updateCodingAgentReadme(version, path = "packages/coding-agent/README.md") {
	const content = readFileSync(path, "utf-8");
	const updated = content
		.replace(
			/\[v\d+\.\d+\.\d+\]\(([^)]*RELEASE_NOTES_v)\d+\.\d+\.\d+(\.md)\)/g,
			`[v${version}]($1${version}$2)`,
		)
		.replace(/RELEASE_NOTES_v\d+\.\d+\.\d+\.md/g, `RELEASE_NOTES_v${version}.md`)
		.replace(/npm:omk-book-to-skill@\d+\.\d+\.\d+/g, `npm:omk-book-to-skill@${version}`);
	if (updated !== content) {
		writeFileSync(path, updated);
		console.log(`  Updated ${path} version references to ${version}`);
	}
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

export function computeTargetVersion(target, current) {
	if (BUMP_TYPES.has(target)) {
		const [major, minor, patch] = current.split(".").map(Number);
		return target === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
	}
	return target;
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

// 1.5. Fail fast: release notes for the target version must exist before any
// side effect (version bump rewrites every package.json and the lockfile).
const expectedVersion = computeTargetVersion(RELEASE_TARGET, getVersion());
if (!releaseNotesExist(expectedVersion)) {
	console.error(
		`Error: .github/RELEASE_NOTES_v${expectedVersion}.md does not exist. Write the release notes first, then re-run.`,
	);
	process.exit(1);
}

// 2. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 3. Update changelogs, then sync the README release surface BEFORE the
// consistency gate: the gate compares README against the new changelog
// version, so syncing after it always fails.
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
updateCodingAgentReadme(version);
run("node scripts/sync-readme-releases.mjs");
run("node scripts/check-release-consistency.mjs --release");
console.log();

// 4. Regenerate release artifacts.
//
// Only deterministic ones. The model catalogs are NOT regenerated here: their
// generators read live provider APIs, which made the shipped artifact a
// function of whichever endpoints answered the machine cutting the release.
// A v0.98.0 attempt dropped 26 of 57 Cloudflare models and 32 OpenRouter
// models, then failed typecheck against model ids the tests reference.
// Refresh the catalogs deliberately with `npm run models:refresh`, review the
// diff, and commit it as its own change. The shrinkwrap stays because it is
// derived from the lockfile already in the tree.
console.log("Regenerating release artifacts...");
run("npm run shrinkwrap:coding-agent");
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
