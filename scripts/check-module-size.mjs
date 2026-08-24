/**
 * Module-size ratchet.
 *
 * The house rule is a 250-line ceiling on pure LOC (blank lines, line comments,
 * and block comments excluded). 133 of 572 source modules already exceed it, so
 * a hard ceiling would fail on day one and be switched off. This gate instead
 * ratchets: every current violation is frozen at its present size in
 * `scripts/module-size-baseline.json`, and the build fails when
 *
 *   - a file that is not in the baseline crosses the ceiling, or
 *   - a baseline file grows beyond its recorded size.
 *
 * Shrinking is always allowed, and a file that drops below its record (or under
 * the ceiling entirely) is reported so the baseline can be tightened. The
 * baseline can only move down, so module size is monotonically non-increasing.
 *
 * Usage:
 *   node scripts/check-module-size.mjs            # verify
 *   node scripts/check-module-size.mjs --update   # rewrite the baseline (down only)
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODULE_SIZE_CEILING = 250;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "scripts", "module-size-baseline.json");
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "examples"]);

/**
 * Count executable lines: blanks, `//` comments, and `/* *​/` blocks do not count.
 * Deliberately lexical rather than AST-based so the gate stays dependency-free
 * and cannot fail on a file the parser rejects.
 */
export function countPureLoc(source) {
	let count = 0;
	let inBlockComment = false;
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim();
		if (inBlockComment) {
			if (line.includes("*/")) inBlockComment = false;
			continue;
		}
		if (line === "") continue;
		if (line.startsWith("//")) continue;
		if (line.startsWith("*")) continue;
		if (line.startsWith("/*")) {
			if (!line.includes("*/")) inBlockComment = true;
			continue;
		}
		count += 1;
	}
	return count;
}

/** Source modules subject to the rule: no tests, declarations, or generated output. */
export function isCheckedModule(fileName) {
	if (!fileName.endsWith(".ts")) return false;
	if (fileName.endsWith(".d.ts")) return false;
	if (fileName.endsWith(".generated.ts")) return false;
	return !fileName.includes(".test.");
}

function collectModules(directory, out) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const child = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectModules(child, out);
			continue;
		}
		if (entry.isFile() && isCheckedModule(entry.name)) out.push(child);
	}
	return out;
}

/** Measure every checked module under `packages/<pkg>/src`. */
export function measureModules(root = repoRoot) {
	const packagesDir = join(root, "packages");
	const sizes = new Map();
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		let modules;
		try {
			modules = collectModules(join(packagesDir, entry.name, "src"), []);
		} catch {
			continue; // package has no src/
		}
		for (const file of modules) {
			sizes.set(relative(root, file).replace(/\\/g, "/"), countPureLoc(readFileSync(file, "utf-8")));
		}
	}
	return sizes;
}

/**
 * Compare measured sizes against the frozen baseline.
 * Returns violations (build-failing) and tightenings (baseline may shrink).
 */
export function evaluateModuleSizes(sizes, baseline, ceiling = MODULE_SIZE_CEILING) {
	const violations = [];
	const tightenings = [];

	for (const [file, size] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
		const allowed = baseline[file];
		if (allowed === undefined) {
			if (size > ceiling) {
				violations.push({ allowed: ceiling, file, kind: "new_violation", size });
			}
			continue;
		}
		if (size > allowed) {
			violations.push({ allowed, file, kind: "grew_past_baseline", size });
		} else if (size < allowed) {
			tightenings.push({ allowed, file, size });
		}
	}

	for (const file of Object.keys(baseline)) {
		if (!sizes.has(file)) tightenings.push({ allowed: baseline[file], file, size: 0 });
	}

	return { tightenings, violations };
}

/** Baseline entries for everything currently above the ceiling. */
export function buildBaseline(sizes, ceiling = MODULE_SIZE_CEILING) {
	const next = {};
	for (const file of [...sizes.keys()].sort()) {
		const size = sizes.get(file);
		if (size > ceiling) next[file] = size;
	}
	return next;
}

function readBaseline() {
	try {
		return JSON.parse(readFileSync(baselinePath, "utf-8"));
	} catch {
		return {};
	}
}

function main(argv) {
	const sizes = measureModules();

	if (argv.includes("--update")) {
		const next = buildBaseline(sizes);
		writeFileSync(baselinePath, `${JSON.stringify(next, null, "\t")}\n`);
		console.log(`Module-size baseline written: ${Object.keys(next).length} modules above ${MODULE_SIZE_CEILING}.`);
		return 0;
	}

	const baseline = readBaseline();
	const { tightenings, violations } = evaluateModuleSizes(sizes, baseline);

	if (violations.length > 0) {
		console.error(`Module-size ratchet failed (${violations.length}):`);
		for (const violation of violations) {
			const reason =
				violation.kind === "new_violation"
					? `exceeds the ${MODULE_SIZE_CEILING}-line ceiling`
					: `grew past its baseline of ${violation.allowed}`;
			console.error(`  ${violation.file}: ${violation.size} lines ${reason}`);
		}
		console.error("\nSplit the module, or justify a deliberate baseline change in review.");
		return 1;
	}

	if (tightenings.length > 0) {
		console.log(`Module-size OK. ${tightenings.length} module(s) shrank — run with --update to tighten the baseline.`);
		return 0;
	}

	console.log(`Module-size OK. ${Object.keys(baseline).length} module(s) held at baseline.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
