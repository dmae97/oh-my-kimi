#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const semverPattern = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const controlPanelVersionPattern = new RegExp(String.raw`omk v(${semverPattern})\s*·\s*OMK(?::)?//CONTROL`, "g");
const strictTagPattern = /^(?:release-)?v(\d+)\.(\d+)\.(\d+)$/;
const releaseBadgePattern = /release-v(\d+\.\d+\.\d+)/;
const releaseNotesLinkPattern = /RELEASE_NOTES_v(\d+\.\d+\.\d+)\.md/;
const releaseNotesFilePattern = /^RELEASE_NOTES_v(\d+)\.(\d+)\.(\d+)\.md$/;
const canonicalRepositoryUrl = "git+https://github.com/dmae97/omk.git";

const args = parseArgs(process.argv.slice(2));
const root = args.root;
const failures = [];
const issues = [];

const workspacePackages = readWorkspacePackages(root);
validatePackageRepositoryMetadata(root, workspacePackages);
const versionSet = new Set(workspacePackages.map((pkg) => pkg.version));
if (versionSet.size !== 1) {
	fail("package_versions_not_lockstep", {
		versions: Object.fromEntries(workspacePackages.map((pkg) => [pkg.name, pkg.version])),
	});
}

const codingAgent = workspacePackages.find((pkg) => pkg.name === "open-multi-agent-kit");
if (!codingAgent) {
	fail("missing_coding_agent_package", { expected: "open-multi-agent-kit" });
}

const packageVersion = codingAgent?.version ?? [...versionSet][0] ?? "0.0.0";
const latestRelease = validateCodingAgentChangelog(root, packageVersion, args.release);
validateConfigVersionSource(root);
validateControlPanelVersionSource(root);
validateThemeIdentity(root);
validateReadmeReleaseNotes(root, latestRelease, packageVersion, args.release);
validateHardcodedControlPanelVersions(root, packageVersion);

// Additive hardening (do not remove or reshape the checks above): catch release-lineage and
// release-surface drift that the checks above cannot see. Non-release mode reports these as
// warnings only (issues[] with severity "warning", exit 0) so day-to-day `npm run check` keeps
// passing on a repo that is mid-cycle; --release mode escalates the same findings to errors
// (severity "error", exit 1) so a release cannot re-tag an unmerged release or ship stale docs.
const tagLineage = checkTagLineage(root, packageVersion, args.release, issues);
const releaseSurface = checkReleaseSurface(root, packageVersion, args.release, issues);

if (failures.length > 0 || issues.some((issue) => issue.severity === "error")) {
	for (const failure of failures) {
		console.error(`${failure.code}: ${JSON.stringify(failure.details)}`);
	}
	for (const issue of issues) {
		if (issue.severity === "error") {
			console.error(`${issue.id}: ${issue.message}`);
		}
	}
	process.exit(1);
}

for (const issue of issues) {
	if (issue.severity === "warning") {
		console.warn(`${issue.id}: ${issue.message}`);
	}
}

console.log(
	JSON.stringify(
		{
			ok: true,
			packageVersion,
			workspacePackages: workspacePackages.map((pkg) => pkg.name),
			latestReleaseVersion: latestRelease?.version ?? null,
			releaseMode: args.release,
			latestTag: tagLineage.latestTag,
			latestTagReachable: tagLineage.latestTagReachable,
			versionBehindTag: tagLineage.versionBehindTag,
			readmeReleaseVersion: releaseSurface.readmeReleaseVersion,
			codingAgentReadmeReleaseVersion: releaseSurface.codingAgentReadmeReleaseVersion,
			releaseNotesLatestVersion: releaseSurface.releaseNotesLatestVersion,
			drift: releaseSurface.drift,
			issues,
		},
		null,
		2,
	),
);

function parseArgs(argv) {
	let rootArg = process.cwd();
	let release = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--release") {
			release = true;
			continue;
		}
		if (arg === "--root") {
			const value = argv[index + 1];
			if (!value) throw new Error("--root requires a path");
			rootArg = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { root: rootArg, release };
}

function readWorkspacePackages(repoRoot) {
	const packagesDir = join(repoRoot, "packages");
	if (!existsSync(packagesDir)) {
		fail("missing_packages_dir", { path: "packages" });
		return [];
	}
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesDir, entry.name, "package.json"))
		.filter((path) => existsSync(path))
		.map((path) => {
			const pkg = readJson(path);
			return {
				path,
				name: pkg.name ?? basename(path),
				version: pkg.version ?? "0.0.0",
				repositoryUrl: pkg.repository?.url,
			};
		});
}

function validatePackageRepositoryMetadata(repoRoot, packages) {
	for (const pkg of packages) {
		if (pkg.repositoryUrl !== canonicalRepositoryUrl) {
			fail("package_repository_url_mismatch", {
				path: toRepoPath(repoRoot, pkg.path),
				expected: canonicalRepositoryUrl,
				actual: pkg.repositoryUrl ?? null,
			});
		}
	}
}

function validateCodingAgentChangelog(repoRoot, packageVersion, releaseMode) {
	const changelogPath = join(repoRoot, "packages", "coding-agent", "CHANGELOG.md");
	if (!existsSync(changelogPath)) {
		fail("missing_coding_agent_changelog", { path: toRepoPath(repoRoot, changelogPath) });
		return null;
	}
	const text = readFileSync(changelogPath, "utf8");
	const firstSection = text.match(/^## \[([^\]]+)\]/m);
	// During a release the script renames [Unreleased] to the release version and
	// only re-adds [Unreleased] after the release commit, so both --release mode and
	// the plain checks that run between those two commits must accept a top section
	// equal to the current packageVersion (verified against packageVersion below).
	if (!releaseMode && firstSection?.[1] !== "Unreleased" && firstSection?.[1] !== packageVersion) {
		fail("missing_unreleased_top_section", { path: toRepoPath(repoRoot, changelogPath) });
	}
	const latestRelease = [...text.matchAll(/^## \[([^\]]+)\](?:\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2}))?/gm)].find(
		(match) => match[1] !== "Unreleased",
	);
	if (!latestRelease) {
		fail("missing_released_changelog_section", { path: toRepoPath(repoRoot, changelogPath) });
		return null;
	}
	const release = { version: latestRelease[1], date: latestRelease[2] ?? null };
	if (releaseMode && release.version !== packageVersion) {
		fail("changelog_latest_version_mismatch", {
			path: toRepoPath(repoRoot, changelogPath),
			expected: packageVersion,
			actual: release.version,
		});
	}
	return release;
}

function validateConfigVersionSource(repoRoot) {
	const configPath = join(repoRoot, "packages", "coding-agent", "src", "config.ts");
	if (!existsSync(configPath)) {
		fail("missing_config_source", { path: toRepoPath(repoRoot, configPath) });
		return;
	}
	const text = readFileSync(configPath, "utf8");
	if (!/export\s+const\s+VERSION(?:\s*:\s*string)?\s*=\s*pkg\.version\s*\|\|\s*["']0\.0\.0["']/.test(text)) {
		fail("tui_version_not_package_backed", { path: toRepoPath(repoRoot, configPath) });
	}
}

function validateControlPanelVersionSource(repoRoot) {
	const layoutPath = join(
		repoRoot,
		"packages",
		"coding-agent",
		"src",
		"modes",
		"interactive",
		"components",
		"control-panel-layout.ts",
	);
	if (!existsSync(layoutPath)) {
		fail("missing_control_panel_layout", { path: toRepoPath(repoRoot, layoutPath) });
		return;
	}
	const text = readFileSync(layoutPath, "utf8");
	if (!/omk v\$\{content\.version\}\s*·\s*OMK(?::)?\/\/CONTROL/.test(text)) {
		fail("control_panel_title_not_content_version_backed", { path: toRepoPath(repoRoot, layoutPath) });
	}
	if (!text.includes("NIGHT-CITY-MATRIX-V3")) {
		fail("missing_night_city_matrix_marker", { path: toRepoPath(repoRoot, layoutPath) });
	}
}

function validateThemeIdentity(repoRoot) {
	const themePath = join(
		repoRoot,
		"packages",
		"coding-agent",
		"src",
		"modes",
		"interactive",
		"theme",
		"omk-control-grid-dark.json",
	);
	if (!existsSync(themePath)) {
		fail("missing_control_grid_theme", { path: toRepoPath(repoRoot, themePath) });
		return;
	}
	const theme = readJson(themePath);
	if (theme.name !== "omk-control-grid-dark") {
		fail("control_grid_theme_name_mismatch", { path: toRepoPath(repoRoot, themePath), actual: theme.name });
	}
}

function validateReadmeReleaseNotes(repoRoot, latestRelease, packageVersion, releaseMode) {
	const readmePath = join(repoRoot, "README.md");
	if (!existsSync(readmePath)) return;
	const text = readFileSync(readmePath, "utf8");
	const match = text.match(/\.github\/RELEASE_NOTES_v([^.\s)]+(?:\.[^.\s)]+){2})\.md/);
	if (!match) return;
	const linkedVersion = match[1];
	const expectedVersion = releaseMode ? packageVersion : latestRelease?.version;
	if (expectedVersion && linkedVersion !== expectedVersion) {
		const linkedTriple = parseVersionTriple(linkedVersion);
		const expectedTriple = parseVersionTriple(expectedVersion);
		const linkedAhead = Boolean(
			linkedTriple && expectedTriple && compareVersionTriples(linkedTriple, expectedTriple) > 0,
		);
		// Outside release mode a link ahead of the latest changelog release is the
		// expected pre-release alignment state (docs(release): align ... commits land
		// before the Release commit). checkReleaseSurface still reports it as drift.
		if (releaseMode || !linkedAhead) {
			fail("readme_release_notes_version_mismatch", {
				path: toRepoPath(repoRoot, readmePath),
				expected: expectedVersion,
				actual: linkedVersion,
			});
		}
	}
	const releaseNotesPath = join(repoRoot, ".github", `RELEASE_NOTES_v${linkedVersion}.md`);
	if (!existsSync(releaseNotesPath)) {
		fail("missing_release_notes", { path: toRepoPath(repoRoot, releaseNotesPath) });
	}
}

function validateHardcodedControlPanelVersions(repoRoot, packageVersion) {
	for (const file of scanFiles(repoRoot)) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(controlPanelVersionPattern)) {
			const version = match[1];
			fail(version === packageVersion ? "hardcoded_control_panel_version" : "stale_hardcoded_control_panel_version", {
				path: toRepoPath(repoRoot, file),
				version,
				expectedRuntimeSource: "content.version",
			});
		}
	}
}

function scanFiles(repoRoot) {
	const candidates = [join(repoRoot, "README.md"), join(repoRoot, "packages", "coding-agent", "README.md")];
	const sourceRoot = join(repoRoot, "packages", "coding-agent", "src");
	if (existsSync(sourceRoot)) collectFiles(sourceRoot, candidates);
	return candidates.filter((path) => existsSync(path) && statSync(path).isFile());
}

function collectFiles(directory, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectFiles(path, files);
		} else if (/\.(?:ts|tsx|js|jsx|md)$/.test(entry.name)) {
			files.push(path);
		}
	}
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Unable to parse JSON file ${path}: ${message}`);
		process.exit(1);
	}
}

// (a) Tag lineage: a tag can exist (with a completed GitHub release) without ever being merged
// to main - e.g. v0.90.1 was tagged and released on GitHub, but its two release commits never
// landed on main, so `git merge-base --is-ancestor v0.90.1 HEAD` is false. Re-running a version
// bump in that state would try to recreate the same tag and collide with the existing one.
// Local tags can also include versions from an unrelated history (e.g. an imported/fetched
// remote's tags that share no commits with HEAD at all); those are excluded by requiring a
// merge-base to exist before a tag is considered a lineage candidate.
function checkTagLineage(repoRoot, packageVersion, releaseMode, issues) {
	const tagListing = runGit(repoRoot, ["tag", "--list", "v*", "release-v*"]);
	if (!tagListing.ok) {
		// No git tags (or not a git checkout at all): nothing to compare against, no issue.
		return { latestTag: null, latestTagReachable: null, versionBehindTag: false };
	}

	const candidates = tagListing.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((tag) => {
			const match = strictTagPattern.exec(tag);
			return match ? { tag, triple: [Number(match[1]), Number(match[2]), Number(match[3])] } : null;
		})
		.filter((entry) => entry !== null)
		.sort((a, b) => compareVersionTriples(b.triple, a.triple));

	let latestCandidate = null;
	for (const candidate of candidates) {
		if (runGit(repoRoot, ["merge-base", candidate.tag, "HEAD"]).ok) {
			latestCandidate = candidate;
			break;
		}
	}

	if (!latestCandidate) {
		return { latestTag: null, latestTagReachable: null, versionBehindTag: false };
	}

	const latestTag = latestCandidate.tag;
	const latestTagReachable = runGit(repoRoot, ["merge-base", "--is-ancestor", latestTag, "HEAD"]).ok;
	const packageTriple = parseVersionTriple(packageVersion);
	const tagTriple = latestCandidate.triple;
	const versionBehindTag = Boolean(
		packageTriple && tagTriple && compareVersionTriples(packageTriple, tagTriple) < 0,
	);
	const severity = releaseMode ? "error" : "warning";

	if (!latestTagReachable) {
		issues.push({
			id: "release_tag_not_merged",
			severity,
			message: `Tag ${latestTag} exists (with a completed GitHub release) but is not an ancestor of HEAD, so its release commits were never merged to main. A version bump would try to recreate ${latestTag} and collide.`,
		});
	}
	if (versionBehindTag) {
		issues.push({
			id: "package_version_behind_tag",
			severity,
			message: `Workspace packageVersion ${packageVersion} is lower than local tag ${latestTag}.`,
		});
	}

	return { latestTag, latestTagReachable, versionBehindTag };
}

// (b) Release surface: README.md and packages/coding-agent/README.md advertise a release via a
// badge (`release-vX.Y.Z`) and/or a `.github/RELEASE_NOTES_vX.Y.Z.md` link. That surface can lag
// both the current workspace packageVersion and the newest release-notes file actually present
// on disk (e.g. READMEs pinned at v0.80.8 while packages already moved to v0.90.0).
function checkReleaseSurface(repoRoot, packageVersion, releaseMode, issues) {
	const readmeReleaseVersion = parseReleaseSurfaceVersion(repoRoot, "README.md");
	const codingAgentReadmeReleaseVersion = parseReleaseSurfaceVersion(
		repoRoot,
		join("packages", "coding-agent", "README.md"),
	);
	const releaseNotesLatestVersion = findLatestReleaseNotesVersion(repoRoot);
	const severity = releaseMode ? "error" : "warning";

	const mismatches = [];
	if (readmeReleaseVersion && codingAgentReadmeReleaseVersion && readmeReleaseVersion !== codingAgentReadmeReleaseVersion) {
		mismatches.push(
			`README.md advertises v${readmeReleaseVersion} while packages/coding-agent/README.md advertises v${codingAgentReadmeReleaseVersion}`,
		);
	}
	if (readmeReleaseVersion && releaseNotesLatestVersion && readmeReleaseVersion !== releaseNotesLatestVersion) {
		mismatches.push(
			`README release surface v${readmeReleaseVersion} does not match the latest local .github/RELEASE_NOTES_v${releaseNotesLatestVersion}.md`,
		);
	}
	if (readmeReleaseVersion && readmeReleaseVersion !== packageVersion) {
		const readmeTriple = parseVersionTriple(readmeReleaseVersion);
		const packageTriple = parseVersionTriple(packageVersion);
		const readmeAhead = Boolean(
			readmeTriple && packageTriple && compareVersionTriples(readmeTriple, packageTriple) > 0,
		);
		// A README surface ahead of packageVersion is the pre-release alignment state
		// (docs(release): align ... commits land before the Release version bump).
		if (!readmeAhead || releaseMode) {
			mismatches.push(
				`README release surface v${readmeReleaseVersion} is ${readmeAhead ? "ahead of" : "behind"} workspace packageVersion v${packageVersion}`,
			);
		}
	}

	const drift = mismatches.length > 0;
	if (drift) {
		issues.push({ id: "readme_release_surface_drift", severity, message: mismatches.join("; ") });
	}

	return { readmeReleaseVersion, codingAgentReadmeReleaseVersion, releaseNotesLatestVersion, drift };
}

function parseReleaseSurfaceVersion(repoRoot, relativePath) {
	const path = join(repoRoot, relativePath);
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const badgeMatch = text.match(releaseBadgePattern);
	if (badgeMatch) return badgeMatch[1];
	const linkMatch = text.match(releaseNotesLinkPattern);
	if (linkMatch) return linkMatch[1];
	return null;
}

function findLatestReleaseNotesVersion(repoRoot) {
	const dir = join(repoRoot, ".github");
	if (!existsSync(dir)) return null;

	let best = null;
	let bestTriple = null;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const match = releaseNotesFilePattern.exec(entry.name);
		if (!match) continue;
		const triple = [Number(match[1]), Number(match[2]), Number(match[3])];
		if (!bestTriple || compareVersionTriples(triple, bestTriple) > 0) {
			best = `${match[1]}.${match[2]}.${match[3]}`;
			bestTriple = triple;
		}
	}
	return best;
}

// Runs git read-only (no network, no mutation). Any failure (not a git checkout, no such ref,
// git missing, etc.) degrades to { ok: false } so callers can skip gracefully instead of crashing.
function runGit(repoRoot, gitArgs) {
	const result = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" });
	if (result.error || result.status !== 0) {
		return { ok: false, stdout: "" };
	}
	return { ok: true, stdout: result.stdout ?? "" };
}

function parseVersionTriple(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersionTriples(a, b) {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function fail(code, details) {
	failures.push({ code, details });
}

function toRepoPath(repoRoot, path) {
	return relative(repoRoot, path) || ".";
}
