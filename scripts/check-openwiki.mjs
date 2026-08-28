#!/usr/bin/env node
// Integrity checks for the generated OpenWiki (openwiki/).
//
// Validates what the generator can leave behind silently:
//   1. Every `/openwiki/...` internal link resolves to an existing page.
//   2. No stale "broken internal link" markers remain once targets are restored.
//   3. `.last-update.json` exists and parses with a known status.
//   4. Every frontmatter `symbols:` entry binds to one of that page's own
//      declared `source_paths:` as a whole identifier.
//   5. An `interrupted` corpus is covered by a digest-bound manual review.
//   6. The README-referenced entry page exists.
//
// Usage: node scripts/check-openwiki.mjs   (exit 0 = ok, exit 1 = drift)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const wikiDir = join(repoRoot, "openwiki");

const LINK = /\[[^\]]*\]\((\/openwiki\/[^)\s]+)\)/g;
const MARKER = /<!-- openwiki: broken internal link \[([^\]]+)\]/g;
// Fenced code blocks contain illustrative links, not real ones — strip them the
// same way scripts/check-doc-links.mjs does before scanning.
const FENCE = /^(`{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const SYMBOLS_LINE = /^\s*symbols:\s*\[(.*?)\]/gm;
const SOURCE_PATHS_LINE = /^\s*source_paths:\s*\[(.*?)\]/gm;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".json", ".md", ".go", ".sh"];

const short = (value) => String(value).slice(0, 12);

function walkMarkdown(dir) {
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) entries.push(...walkMarkdown(full));
		else if (entry.name.endsWith(".md")) entries.push(full);
	}
	return entries;
}

/**
 * The reviewable corpus: every markdown page, as repo-relative path plus text.
 * Generator bookkeeping (`.last-update.json`) is excluded because it changes on
 * every run without changing a single reviewed sentence.
 */
export function collectCorpus(dir = wikiDir) {
	if (!existsSync(dir)) return [];
	return walkMarkdown(dir).map((file) => ({
		rel: file.slice(repoRoot.length + 1),
		content: readFileSync(file, "utf8"),
	}));
}

/**
 * Content address for a corpus. Order-independent, and length-delimited so that
 * moving text across a page boundary cannot produce the same digest.
 */
export function computeCorpusDigest(entries) {
	const hash = createHash("sha256");
	const sorted = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	for (const { rel, content } of sorted) {
		hash.update(`${rel.length}:${rel}`);
		hash.update(`${Buffer.byteLength(content)}:${content}`);
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Decide whether the recorded generator state may be trusted.
 *
 * Spec 014 blocker 1: an `interrupted` pass means the generator stopped partway,
 * so nothing vouches for what it left behind. That corpus fails closed unless a
 * manual-review record binds a human decision to this exact content digest.
 * Anchoring the record to the digest rather than to a commit is what lets an
 * approved corpus survive later commits: code moving on is a staleness warning,
 * while the corpus itself changing invalidates the review outright.
 */
export function evaluateFreshness({ state, head, review, corpusDigest }) {
	const problems = [];
	const warnings = [];

	if (!("status" in state) || !["complete", "interrupted"].includes(state.status)) {
		problems.push(`.last-update.json: unknown status "${state.status}"`);
		return { problems, warnings };
	}
	if (!state.gitHead) {
		problems.push(".last-update.json: gitHead missing — staleness tracking disabled");
		return { problems, warnings };
	}

	if (state.status === "complete") {
		if (head && state.gitHead !== head) {
			warnings.push(`corpus was generated at ${short(state.gitHead)}; HEAD has moved since`);
		}
		return { problems, warnings };
	}

	if (!review) {
		problems.push(
			`.last-update.json: status "interrupted" requires openwiki/.manual-review.json binding a review to corpus digest ${corpusDigest}`,
		);
		return { problems, warnings };
	}
	if (typeof review.corpusDigest !== "string" || review.corpusDigest.length === 0) {
		problems.push(".manual-review.json: corpusDigest missing — a review must bind to an exact corpus");
		return { problems, warnings };
	}
	if (review.corpusDigest !== corpusDigest) {
		problems.push(
			`.manual-review.json: covers a different corpus (${short(review.corpusDigest)}) than the tree holds (${short(corpusDigest)}) — re-review or regenerate`,
		);
		return { problems, warnings };
	}

	warnings.push(`interrupted corpus accepted by manual review of ${review.reviewedAt ?? "(undated)"}`);
	if (head && review.gitHead && review.gitHead !== head) {
		warnings.push(`code has moved since the review (${short(review.gitHead)} -> ${short(head)}); re-review before release`);
	}
	return { problems, warnings };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Check that each symbol a page claims as evidence really is declared in one of
 * the source paths that same page points at.
 *
 * The predecessor matched every symbol against one concatenated haystack of the
 * whole repository, which cannot fail for any plausible-looking identifier: the
 * characters `AgentLoop` occur somewhere regardless of whether the documented
 * module declares it. Binding a symbol to the page's own `source_paths` is what
 * makes the frontmatter an evidence anchor rather than a spell-check.
 *
 * `readSource` is injected so this stays pure and testable; it returns the text
 * of a declared path (files concatenated, for a directory) or null if missing.
 */
export function evaluateSymbolBinding({ rel, symbols, sourcePaths, readSource }) {
	if (symbols.length === 0) return [];
	if (sourcePaths.length === 0) {
		return [`${rel}: declares symbols ${symbols.join(", ")} but no source_paths to bind them to`];
	}

	const problems = [];
	const sources = new Map();
	for (const path of sourcePaths) {
		const text = readSource(path);
		if (text === null) problems.push(`${rel}: declared source path does not exist: ${path}`);
		else sources.set(path, text);
	}

	for (const symbol of new Set(symbols)) {
		const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
		// A symbol may name a declared path itself (script and tool names do this),
		// which is already an exact source-path binding.
		const namesADeclaredPath = sourcePaths.some((path) => {
			const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
			return base === symbol || base.replace(/\.[^.]+$/, "") === symbol;
		});
		const bound = namesADeclaredPath || [...sources.values()].some((text) => pattern.test(text));
		if (!bound) {
			problems.push(`${rel}: symbol "${symbol}" is not declared in its source_paths (${sourcePaths.join(", ")})`);
		}
	}
	return problems;
}

/** Read a declared source path: a file verbatim, a directory as its concatenated sources. */
function readDeclaredSource(path) {
	const full = join(repoRoot, path);
	if (!existsSync(full)) return null;
	let stat;
	try {
		stat = readdirSync(full, { withFileTypes: true });
	} catch {
		try {
			return readFileSync(full, "utf8");
		} catch {
			return null;
		}
	}
	const chunks = [];
	const walk = (dir, entries) => {
		for (const entry of entries) {
			const child = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist") continue;
				try {
					walk(child, readdirSync(child, { withFileTypes: true }));
				} catch {
					// unreadable directory: skip rather than fail the whole gate
				}
			} else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
				try {
					chunks.push(readFileSync(child, "utf8"));
				} catch {
					// unreadable file: skip
				}
			}
		}
	};
	walk(full, stat);
	return chunks.join("\n");
}

/** Pull a bracketed frontmatter list (`symbols:`, `source_paths:`) into trimmed entries. */
function frontmatterList(frontmatter, pattern) {
	const values = [];
	for (const line of frontmatter.matchAll(pattern)) {
		for (const raw of line[1].split(",")) {
			const value = raw.trim().replace(/^['"]|['"]$/g, "");
			if (value) values.push(value);
		}
	}
	return values;
}

function stripFences(text) {
	return text.replace(FENCE, "");
}

function linkTargetPath(link) {
	const pathOnly = decodeURIComponent(link).split("#")[0];
	return join(repoRoot, pathOnly.replace(/^\//, ""));
}

/** Run every integrity check. Returns findings instead of exiting, so it is testable. */
export function runGate(dir = wikiDir) {
	const problems = [];
	const warnings = [];

	// The corpus is worktree-only and regenerated by CI, so its absence is a state
	// to report rather than a fault: a corpus that does not exist misleads nobody,
	// and failing here would make every commit depend on untracked scratch output.
	if (!existsSync(dir)) {
		warnings.push("openwiki/ absent — worktree-only corpus not generated; run `openwiki code --update` to build it");
		return { problems, warnings, pageCount: 0 };
	}

	const pages = walkMarkdown(dir);
	if (pages.length === 0) {
		problems.push("openwiki/ contains no markdown pages");
	}

	for (const file of pages) {
		const rel = file.slice(repoRoot.length + 1);
		const text = stripFences(readFileSync(file, "utf8"));

		for (const match of text.matchAll(LINK)) {
			if (!existsSync(linkTargetPath(match[1]))) {
				problems.push(`${rel}: unresolved link -> ${match[1]}`);
			}
		}

		for (const match of text.matchAll(MARKER)) {
			if (existsSync(linkTargetPath(match[1]))) {
				problems.push(`${rel}: stale broken-link marker for restored target ${match[1]} (delete the comment)`);
			} else {
				problems.push(`${rel}: unresolved marked link -> ${match[1]}`);
			}
		}

		// Frontmatter `symbols:` is the evidence-pinning field, and regenerated wikis
		// tend to invent plausible names — so each one must bind to a declared path.
		const fm = FRONTMATTER.exec(text);
		if (fm) {
			problems.push(
				...evaluateSymbolBinding({
					rel,
					symbols: frontmatterList(fm[1], SYMBOLS_LINE),
					sourcePaths: frontmatterList(fm[1], SOURCE_PATHS_LINE),
					readSource: readDeclaredSource,
				}),
			);
		}
	}

	const lastUpdatePath = join(dir, ".last-update.json");
	const manualReviewPath = join(dir, ".manual-review.json");
	if (!existsSync(lastUpdatePath)) {
		problems.push("openwiki/.last-update.json missing (generator never completed)");
	} else {
		let state = null;
		try {
			state = JSON.parse(readFileSync(lastUpdatePath, "utf8"));
		} catch {
			problems.push(".last-update.json: invalid JSON");
		}
		let review = null;
		if (state && existsSync(manualReviewPath)) {
			try {
				review = JSON.parse(readFileSync(manualReviewPath, "utf8"));
			} catch {
				problems.push(".manual-review.json: invalid JSON");
				state = null;
			}
		}
		if (state) {
			let head = null;
			try {
				head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
			} catch {
				// not a git checkout (tarball/CI artifact): skip freshness comparison
			}
			const verdict = evaluateFreshness({
				state,
				head,
				review,
				corpusDigest: computeCorpusDigest(collectCorpus(dir)),
			});
			problems.push(...verdict.problems);
			warnings.push(...verdict.warnings);
		}
	}

	for (const entry of ["openwiki/quickstart.md", "openwiki/index.md"]) {
		if (!existsSync(join(repoRoot, entry))) {
			problems.push(`entry page ${entry} missing (README points fresh sessions here)`);
		}
	}

	return { problems, warnings, pageCount: pages.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { problems, warnings, pageCount } = runGate();
	for (const warning of warnings) console.error(`[warn] ${warning}`);
	if (problems.length > 0) {
		console.error(`OpenWiki integrity: ${problems.length} problem(s)`);
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log(
		pageCount === 0
			? "OpenWiki integrity: ok (no corpus to validate)"
			: `OpenWiki integrity: ok (${pageCount} pages, all internal links resolve)`,
	);
}
