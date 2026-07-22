#!/usr/bin/env node

// Validates markdown docs: relative .md links resolve, and no references to
// the legacy upstream repo remain (except earendil-works/gondolin, a separate project).
//
// Usage: node scripts/check-doc-links.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoots = ["README.md", "docs/adr", "packages/coding-agent/docs", "packages/coding-agent/README.md"];
const allowedLegacyHostPatterns = [/^https:\/\/github\.com\/earendil-works\/gondolin/, /^https:\/\/github\.com\/earendil-works\/gondolin\//];
const legacyPattern = /https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/earendil-works\/(?!gondolin)\S*/g;
const linkPattern = /\]\(([^)\s]+)\)/g;

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
