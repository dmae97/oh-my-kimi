#!/usr/bin/env node
// Output gate for the OpenWiki generator (spec 014 blockers 3 and 4).
//
// The generator is a model writing files into a checkout, and CI then uploads
// whatever it wrote as an artifact and opens a pull request for it. If that set
// can include `AGENTS.md`, `CLAUDE.md`, or the workflow that runs the model,
// then repository content the model reads can rewrite the rules agents follow,
// or the CI job itself. This gate answers one question — did the generator
// write anything outside `openwiki/`? — and refuses the run if it did.
//
// It also scans the generated corpus for operator-private paths, because the
// generator reads a working checkout and can quote a path back into prose.
//
// Usage: node scripts/check-openwiki-output.mjs   (exit 0 = ok, exit 1 = reject)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The only tree the generator may write. */
export const OPENWIKI_OUTPUT_PREFIX = "openwiki/";

/**
 * Operator-private markers. These are paths that exist on a maintainer machine
 * and must never be quoted into a published page.
 */
const PRIVATE_PATTERNS = [
	{ label: "operator home directory", pattern: /\/home\/[a-z][a-z0-9_-]*\// },
	{ label: "Windows user directory", pattern: /[A-Za-z]:\\Users\\/ },
	{ label: "owner-private agent document", pattern: /AGENTS\.(?:GODMODE|override|stub)[.\w]*\.md/ },
	{ label: "private evidence tree", pattern: /(?:^|[\s"'`(])\.om[ox]\// },
	{ label: "private agent home", pattern: /(?:^|[\s"'`(])\.pi\/agent/ },
];

/** Normalise a reported path without letting it escape the repository. */
function normalise(path) {
	return path.replace(/^\.\//, "");
}

/**
 * Reject every changed path that is not inside the generated corpus.
 *
 * The prefix test is on a path segment, not a string prefix, so `openwiki-evil/`
 * and `openwiki.md` do not pass as the corpus. A `..` segment is rejected
 * outright rather than resolved, since a generator has no reason to emit one.
 */
export function evaluateChangedPaths(paths) {
	const violations = [];
	for (const raw of paths) {
		const path = normalise(raw);
		if (path === "") continue;
		if (path.startsWith("/") || path.split("/").includes("..")) {
			violations.push(`generator wrote outside the corpus: ${raw}`);
			continue;
		}
		if (!path.startsWith(OPENWIKI_OUTPUT_PREFIX)) {
			violations.push(`generator wrote outside the corpus: ${raw}`);
		}
	}
	return violations;
}

/**
 * Credential shapes. The generator reads a working checkout, so a key sitting
 * in an untracked scratch file can be quoted into prose. Matches are reported
 * by file and label only — echoing the match would copy the secret into CI logs.
 */
const SECRET_PATTERNS = [
	{ label: "provider API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
	{ label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ label: "Slack token", pattern: /\bxox[eabprs]-[A-Za-z0-9-]{20,}/ },
	{ label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{24,}/ },
];

/** Find credential shapes inside the generated pages. Never quotes the match. */
export function findSecretHits(paths, readContent) {
	const hits = [];
	for (const path of paths) {
		let text;
		try {
			text = readContent(path);
		} catch {
			continue;
		}
		if (typeof text !== "string") continue;
		for (const { label, pattern } of SECRET_PATTERNS) {
			if (pattern.test(text)) hits.push(`${path}: possible secret leaked (${label})`);
		}
	}
	return hits;
}

/** Find operator-private paths quoted inside the generated pages. */
export function findPrivatePathHits(paths, readContent) {
	const hits = [];
	for (const path of paths) {
		let text;
		try {
			text = readContent(path);
		} catch {
			continue; // unreadable file: the path gate already decides admissibility
		}
		if (typeof text !== "string") continue;
		for (const { label, pattern } of PRIVATE_PATTERNS) {
			if (pattern.test(text)) hits.push(`${path}: private path leaked (${label})`);
		}
	}
	return hits;
}

/**
 * Full gate. Path admissibility is decided first, and only admitted files are
 * read — a rejected file's contents are not the gate's business.
 */
export function runOutputGate({ changedPaths, readContent }) {
	const problems = evaluateChangedPaths(changedPaths);
	const admitted = changedPaths.map(normalise).filter((path) => path.startsWith(OPENWIKI_OUTPUT_PREFIX));
	// Both scanners want the same text, so read each admitted file once.
	const cache = new Map();
	const readOnce = (path) => {
		if (!cache.has(path)) cache.set(path, readContent(path));
		return cache.get(path);
	};
	problems.push(...findSecretHits(admitted, readOnce));
	problems.push(...findPrivatePathHits(admitted, readOnce));
	return { problems };
}

/** Paths git reports as changed, added, or untracked in the working tree. */
function changedPathsFromGit() {
	const output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return output
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter((line) => line !== "")
		.map((line) => (line.includes(" -> ") ? line.slice(line.indexOf(" -> ") + 4) : line));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const changedPaths = changedPathsFromGit();
	const { problems } = runOutputGate({
		changedPaths,
		readContent: (path) => readFileSync(resolve(repoRoot, path), "utf8"),
	});

	if (problems.length > 0) {
		console.error(`OpenWiki output gate: ${problems.length} problem(s)`);
		for (const problem of problems) console.error(`  - ${problem}`);
		console.error("\nThe generator may only write openwiki/. Reject this run rather than publishing it.");
		process.exit(1);
	}
	console.log(`OpenWiki output gate: ok (${changedPaths.length} changed path(s), all inside ${OPENWIKI_OUTPUT_PREFIX})`);
}
