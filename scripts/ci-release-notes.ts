#!/usr/bin/env bun
/**
 * Generate aggregated release notes from per-package CHANGELOG.md files.
 *
 * Reads the version from `GITHUB_REF_NAME` (or the first CLI arg, with or
 * without a leading `v`), then collects the `## [version]` section of every
 * `packages/*\/CHANGELOG.md` and emits a single markdown document grouped by
 * `package.json` `name`. Sections without entries are skipped.
 *
 * Usage:
 *   bun scripts/ci-release-notes.ts                     # writes release-notes.md
 *   bun scripts/ci-release-notes.ts v15.4.3             # explicit tag/version
 *   bun scripts/ci-release-notes.ts 15.4.3 notes.md     # custom output path
 *
 * Intended for the `release_github` CI job: the output is passed to
 * `softprops/action-gh-release` via `body_path:`. The action's
 * `generate_release_notes: true` still appends the auto-generated PR list
 * underneath, so this only adds curated context — it does not replace it.
 */

import { Glob } from "bun";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");

function stripVPrefix(tag: string): string {
	return tag.replace(/^v/, "").trim();
}

function extractVersionSection(content: string, version: string): string {
	const lines = content.split("\n");
	const headingPrefix = `## [${version}]`;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(headingPrefix)) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return "";
	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		if (lines[i].startsWith("## [")) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trim();
}

async function loadPackageName(pkgDir: string): Promise<string> {
	try {
		const pkg = (await Bun.file(`${pkgDir}/package.json`).json()) as { name?: unknown };
		return typeof pkg.name === "string" ? pkg.name : pkgDir;
	} catch {
		return pkgDir;
	}
}

const tagInput = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
if (!tagInput) {
	console.error(
		"Error: version not provided. Pass as argv (e.g. `v15.4.3`) or set GITHUB_REF_NAME.",
	);
	process.exit(1);
}
const version = stripVPrefix(tagInput);
const outputPath = process.argv[3] ?? "release-notes.md";

const sections: string[] = [];
const changelogPaths = await Array.fromAsync(changelogGlob.scan("."));
changelogPaths.sort();

for (const changelogPath of changelogPaths) {
	const content = await Bun.file(changelogPath).text();
	const section = extractVersionSection(content, version);
	if (!section) continue;
	const pkgDir = changelogPath.replace(/\/CHANGELOG\.md$/, "");
	const name = await loadPackageName(pkgDir);
	sections.push(`## ${name}\n\n${section}`);
}

if (sections.length === 0) {
	console.warn(
		`No CHANGELOG entries found for version ${version}; writing empty release notes to ${outputPath}.`,
	);
	await Bun.write(outputPath, "");
	process.exit(0);
}

const body = `${sections.join("\n\n")}\n`;
await Bun.write(outputPath, body);
console.log(`Wrote ${sections.length} package section(s) to ${outputPath} (version ${version}).`);
