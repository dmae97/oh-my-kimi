#!/usr/bin/env node

// Validates markdown docs: relative .md links resolve, and no references to
// the legacy upstream repo remain (except earendil-works/gondolin, a separate project).
//
// Usage: node scripts/check-doc-links.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoots = ["README.md", "docs/adr", "packages/coding-agent/docs", "packages/coding-agent/README.md"];
const allowedLegacyHostPatterns = [/^https:\/\/github\.com\/earendil-works\/gondolin/, /^https:\/\/github\.com\/earendil-works\/gondolin\//];
const legacyPattern = /https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/earendil-works\/(?!gondolin)\S*/g;
const linkPattern = /\]\(([^)\s]+)\)/g;

/**
 * A link has to resolve in a fresh checkout, not just on the author's disk.
 * The root `docs/` tree is gitignored working material, so a README link into
 * it passed here and failed in CI — which is where a release found out, after
 * the tag had already been pushed. Checking the filesystem alone cannot catch
 * that, because the file really is present locally.
 */
const trackedPaths = new Set(
	execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\0")
		.filter(Boolean),
);

function isShipped(resolvedPath) {
	const rel = relative(repoRoot, resolvedPath).split(sep).join("/");
	if (rel === "") return true;
	if (trackedPaths.has(rel)) return true;
	// A link may target a directory; it ships when anything under it does.
	let isDirectory = false;
	try {
		isDirectory = statSync(resolvedPath).isDirectory();
	} catch {
		return false;
	}
	if (!isDirectory) return false;
	const prefix = `${rel}/`;
	for (const tracked of trackedPaths) {
		if (tracked.startsWith(prefix)) return true;
	}
	return false;
}

const failures = [];

function* walk(target) {
	if (target.endsWith(".md")) {
		yield target;
		return;
	}
	let entries;
	try {
		entries = readdirSync(target, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const child = join(target, entry.name);
		if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
			yield* walk(child);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			yield child;
		}
	}
}

for (const root of docsRoots) {
	for (const file of walk(join(repoRoot, root))) {
		const content = readFileSync(file, "utf8").replace(/^(`{3,})[\s\S]*?^\1[ \t]*$/gm, "");
		// Only a file that ships can strand a reader. Local-only working notes
		// (the gitignored root `docs/` tree) may cross-reference each other freely.
		const sourceShips = isShipped(file);

		for (const match of content.matchAll(legacyPattern)) {
			if (!allowedLegacyHostPatterns.some((p) => p.test(match[0]))) {
				failures.push(`${file}: legacy repo reference ${match[0]}`);
			}
		}

		for (const match of content.matchAll(linkPattern)) {
			const target = match[1];
			if (/^(https?:|mailto:|#)/.test(target)) continue;
			const pathOnly = target.split("#")[0];
			if (!pathOnly) continue;
			const resolved = resolve(dirname(file), pathOnly);
			if (!resolved.startsWith(repoRoot)) continue; // external relative paths are out of scope
			if (!existsSync(resolved)) {
				failures.push(`${file}: broken relative link ${target}`);
			} else if (sourceShips && !isShipped(resolved)) {
				failures.push(`${file}: link ${target} resolves locally but is not committed; a fresh checkout will 404`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("Documentation link check failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Documentation links OK.");
