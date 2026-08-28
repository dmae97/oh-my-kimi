#!/usr/bin/env node

// Syncs the root README release sections from packages/coding-agent/CHANGELOG.md.
// The CHANGELOG is the single source of truth; the root README block between
// <!-- releases:start --> and <!-- releases:end --> is generated.
//
// Usage:
//   node scripts/sync-readme-releases.mjs          # rewrite README.md
//   node scripts/sync-readme-releases.mjs --check  # fail if README.md is out of date
//   node scripts/sync-readme-releases.mjs --releases 4

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const readmePath = join(repoRoot, "README.md");
const changelogPath = join(repoRoot, "packages/coding-agent/CHANGELOG.md");
const codingAgentDir = "packages/coding-agent";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const releasesFlagIndex = args.indexOf("--releases");
const releaseCount = releasesFlagIndex >= 0 ? Number.parseInt(args[releasesFlagIndex + 1], 10) : 3;
if (!Number.isInteger(releaseCount) || releaseCount < 1) {
	console.error("--releases must be a positive integer");
	process.exit(1);
}

const START = "<!-- releases:start -->";
const END = "<!-- releases:end -->";

/**
 * The documentation index carries a `Release notes for vX.Y.Z` link that sits
 * above the generated sections. `check-release-consistency.mjs` reads the first
 * `RELEASE_NOTES_v*.md` match in the file as the advertised release surface, so
 * that index entry is the one that decides. Nothing retargeted it, which stalled
 * a release at the consistency gate after the version bump had already applied.
 */
const RELEASE_NOTES_INDEX_ENTRY =
	/- \[Release notes for v\d+\.\d+\.\d+\]\(\.github\/RELEASE_NOTES_v\d+\.\d+\.\d+\.md\)/;

/** Point the documentation index entry at `version`, leaving generated sections alone. */
export function retargetReleaseNotesPointer(markdown, version) {
	return markdown.replace(
		RELEASE_NOTES_INDEX_ENTRY,
		`- [Release notes for v${version}](.github/RELEASE_NOTES_v${version}.md)`,
	);
}

function parseChangelog(content) {
	const versions = [];
	const pattern = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}\s*$/gm;
	let match;
	while ((match = pattern.exec(content)) !== null) {
		versions.push({ version: match[1], start: match.index, bodyStart: match.index + match[0].length });
	}
	for (let i = 0; i < versions.length; i++) {
		const end = i + 1 < versions.length ? versions[i + 1].start : content.length;
		versions[i].body = content.slice(versions[i].bodyStart, end).trim();
	}
	return versions;
}

// Relative links in the CHANGELOG resolve from packages/coding-agent/; in the root
// README they must resolve from the repo root.
function rewriteLinks(markdown) {
	return markdown.replace(/\]\(([^)\s]+)\)/g, (full, target) => {
		if (/^(https?:|mailto:|#)/.test(target)) return full;
		if (target.startsWith("docs/") || target.startsWith("examples/")) {
			return `](${codingAgentDir}/${target})`;
		}
		if (target.startsWith("../../")) {
			// ../../ escapes packages/coding-agent to the repo root.
			return `](${target.slice("../../".length)})`;
		}
		if (target.startsWith("../")) {
			// ../ resolves to packages/ from packages/coding-agent.
			return `](packages/${target.slice("../".length)})`;
		}
		return full;
	});
}

function generate(versions) {
	const selected = versions.slice(0, releaseCount);
	const parts = [];
	for (const { version, body } of selected) {
		const releaseNotesPath = `.github/RELEASE_NOTES_v${version}.md`;
		let section = `## Release v${version}\n\n${rewriteLinks(body)}`;
		if (existsSync(join(repoRoot, releaseNotesPath))) {
			section += `\n\nRelease notes live in [RELEASE_NOTES_v${version}.md](${releaseNotesPath}).`;
		}
		parts.push(section);
	}
	return `${START}\n\n${parts.join("\n\n")}\n\n${END}`;
}

function main() {
	const changelog = readFileSync(changelogPath, "utf8");
	const versions = parseChangelog(changelog);
	if (versions.length === 0) {
		console.error("No version sections found in packages/coding-agent/CHANGELOG.md");
		process.exit(1);
	}

	const readme = readFileSync(readmePath, "utf8");
	const startIndex = readme.indexOf(START);
	const endIndex = readme.indexOf(END);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		console.error(`README.md must contain ${START} and ${END} markers around the release sections.`);
		process.exit(1);
	}

	const generated = generate(versions);
	const withSections = `${readme.slice(0, startIndex)}${generated}${readme.slice(endIndex + END.length)}`;
	const updated = retargetReleaseNotesPointer(withSections, versions[0].version);

	if (checkOnly) {
		if (updated !== readme) {
			console.error("README.md release sections are out of date with packages/coding-agent/CHANGELOG.md.");
			console.error("Run: node scripts/sync-readme-releases.mjs");
			process.exit(1);
		}
		console.log("README.md release sections are up to date.");
		return;
	}
	writeFileSync(readmePath, updated);
	console.log(`Wrote README.md release sections (${Math.min(releaseCount, versions.length)} releases).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
