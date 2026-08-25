/**
 * Owner-private agent home guard (specs/constitution.md → "Owner-Private Agent Home").
 *
 * `~/.omk/agent` is the owner's private agent home. None of it may enter this public
 * repository. Three checks, ordered by how the boundary has actually been broken:
 *
 *   1. Declared private artifacts stay git-ignored and untracked.
 *   2. No tracked file carries the private operating-stack signature. This catches the
 *      drifted copy a hash cannot: a stale duplicate has a different digest but the same
 *      markers.
 *   3. No tracked file is byte-identical to a private agent-home root document. Skipped
 *      when the private home is absent, which is the normal case in CI.
 *
 * Usage:
 *   node scripts/check-private-agent-home.mjs
 *   OMK_PRIVATE_AGENT_HOME=/path node scripts/check-private-agent-home.mjs
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Paths that must never be tracked. Directories end with `/`. */
export const PRIVATE_ARTIFACTS = [
	".agents/",
	".gjc/",
	".omk/skills/omk-godmod/",
	".omk/skills/system-prompts-leaks/",
	"AGENTS.GODMODE.hard.md",
	"AGENTS.GODMODE.md",
	"AGENTS.override.hard.md",
	"AGENTS.override.md",
	"AGENTS.stub.md",
];

/**
 * Substrings unique to the private operating stack. Deliberately specific: bare skill
 * names appear in immutable changelog entries, so the markers are API calls, module
 * names, private script paths, and the private document title.
 */
export const STACK_MARKERS = [
	"Operational Stack Map",
	"godmode.unify(",
	"guardrail-adversary",
	"omk-godmod/scripts/",
	"v9.5-redteam",
];

/** The guard and its test quote the markers as data. */
export const MARKER_ALLOWLIST = new Set([
	"scripts/check-private-agent-home.mjs",
	"scripts/test/private-agent-home.test.mjs",
]);

/** Private root documents worth comparing byte-for-byte against the tracked tree. */
export const PRIVATE_DOC_PATTERN = /^(AGENTS|SOUL|SUBAGENTS|INTEGRITY|RED-TEAM|DEPLOY)[\w.-]*\.md$/;

export function findUnignoredArtifacts(artifacts, isIgnored) {
	return artifacts.filter((artifact) => !isIgnored(artifact));
}

export function findTrackedArtifacts(artifacts, listTracked) {
	const offenders = [];
	for (const artifact of artifacts) {
		for (const file of listTracked(artifact)) offenders.push(file);
	}
	return offenders;
}

/** Marker hits outside the allowlist, as `{ file, marker }` sorted by path. */
export function findMarkerHits(files, readContent, markers = STACK_MARKERS, allowlist = MARKER_ALLOWLIST) {
	const hits = [];
	for (const file of files) {
		if (allowlist.has(file)) continue;
		const content = readContent(file);
		if (content === undefined) continue;
		for (const marker of markers) {
			if (content.includes(marker)) hits.push({ file, marker });
		}
	}
	return hits.sort((a, b) => a.file.localeCompare(b.file) || a.marker.localeCompare(b.marker));
}

/** Tracked files whose digest matches a private document, as `{ file, source }`. */
export function findDuplicates(trackedDigests, privateDigests) {
	const byDigest = new Map();
	for (const [source, digest] of privateDigests) byDigest.set(digest, source);
	const duplicates = [];
	for (const [file, digest] of trackedDigests) {
		const source = byDigest.get(digest);
		if (source !== undefined) duplicates.push({ file, source });
	}
	return duplicates.sort((a, b) => a.file.localeCompare(b.file));
}

function git(args) {
	return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function isIgnored(path) {
	return git(["check-ignore", "-q", "--no-index", path]).status === 0;
}

function listTracked(path) {
	const result = git(["ls-files", "--", path]);
	return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

function listAllTracked() {
	const result = git(["ls-files"]);
	if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
	return result.stdout.split("\n").filter(Boolean);
}

function digest(content) {
	return createHash("sha256").update(content).digest("hex");
}

function readTextOrUndefined(path) {
	try {
		const content = readFileSync(path);
		// Skip binaries: a NUL byte in the first block means it is not a document.
		return content.includes(0) ? undefined : content.toString("utf8");
	} catch {
		return undefined;
	}
}

function privateDocumentDigests(privateHome) {
	const digests = [];
	if (!existsSync(privateHome)) return digests;
	for (const entry of readdirSync(privateHome, { withFileTypes: true })) {
		if (!entry.isFile() || !PRIVATE_DOC_PATTERN.test(entry.name)) continue;
		const content = readTextOrUndefined(join(privateHome, entry.name));
		if (content !== undefined) digests.push([entry.name, digest(content)]);
	}
	return digests;
}

function main() {
	const privateHome = process.env.OMK_PRIVATE_AGENT_HOME ?? join(homedir(), ".omk", "agent");
	const failures = [];

	for (const artifact of findUnignoredArtifacts(PRIVATE_ARTIFACTS, isIgnored)) {
		failures.push(`not git-ignored: ${artifact} — add it to .gitignore`);
	}
	for (const file of findTrackedArtifacts(PRIVATE_ARTIFACTS, listTracked)) {
		failures.push(`tracked private artifact: ${file} — git rm --cached it`);
	}

	const tracked = listAllTracked();
	const contents = new Map();
	const readContent = (file) => {
		if (!contents.has(file)) contents.set(file, readTextOrUndefined(join(repoRoot, file)));
		return contents.get(file);
	};
	for (const { file, marker } of findMarkerHits(tracked, readContent)) {
		failures.push(`private stack signature in ${file}: ${JSON.stringify(marker)}`);
	}

	const privateDigests = privateDocumentDigests(privateHome);
	if (privateDigests.length === 0) {
		console.log(`Private agent home not present (${privateHome}) — duplicate check skipped.`);
	} else {
		const trackedDigests = [];
		for (const file of tracked) {
			const content = readContent(file);
			if (content !== undefined) trackedDigests.push([file, digest(content)]);
		}
		for (const { file, source } of findDuplicates(trackedDigests, privateDigests)) {
			failures.push(`${file} duplicates the private document ${source}`);
		}
	}

	if (failures.length > 0) {
		console.error(`Private agent home guard failed (${failures.length}):`);
		for (const failure of failures) console.error(`  ${failure}`);
		console.error("\nSee specs/constitution.md → Owner-Private Agent Home.");
		return 1;
	}

	console.log(`Private agent home boundary OK: ${tracked.length} tracked files checked.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
