#!/usr/bin/env node
/**
 * Import-cycle ratchet.
 *
 * A cycle means the modules inside it cannot be read, tested, or reasoned about
 * independently: every one of them can reach every other, so there is no order
 * in which to understand them and no seam at which to split them. That is the
 * concrete form of the layering the plane rule is supposed to enforce, and
 * unlike a plane taxonomy it needs no judgement call — a cycle is a fact about
 * the graph.
 *
 * The repository currently has cycles, including one large tangle, so a hard
 * ban would fail on day one and be switched off. This gate ratchets instead:
 * every module currently inside a cycle is frozen in
 * `scripts/import-cycle-baseline.json`, and the build fails when a module that
 * was not in a cycle becomes part of one. Escaping a cycle is always allowed
 * and is reported so the baseline can be tightened.
 *
 * The unit is the module, not the cycle. Cycle identity is unstable — adding a
 * single edge merges two cycles and renames both — while "is this module stuck
 * in a cycle" stays answerable across refactors.
 *
 * Usage:
 *   node scripts/check-import-cycles.mjs            # verify
 *   node scripts/check-import-cycles.mjs --update   # rewrite the baseline (shrink only)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "scripts", "import-cycle-baseline.json");

/** Static and dynamic import specifiers. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/**
 * Resolve a relative specifier to a repo-relative module path.
 *
 * Bare specifiers return `undefined`: they leave the package, and this gate
 * reasons about layering inside one package tree at a time.
 */
export function resolveImportTarget(fromFile, specifier) {
	if (!specifier.startsWith(".")) return undefined;
	const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
	return posix.basename(resolved).includes(".") ? resolved : `${resolved}.ts`;
}

/** Adjacency over known modules only; edges to unknown paths are dropped. */
export function buildImportGraph(files, readSource) {
	const known = new Set(files);
	const graph = new Map();

	for (const file of files) {
		const edges = new Set();
		const source = readSource(file);
		if (source !== undefined) {
			for (const match of source.matchAll(IMPORT_SPECIFIER)) {
				const target = resolveImportTarget(file, match[1]);
				if (target !== undefined && target !== file && known.has(target)) {
					edges.add(target);
				}
			}
		}
		graph.set(file, edges);
	}
	return graph;
}

/**
 * Strongly connected components larger than one module, via Tarjan's algorithm.
 *
 * A component of size one is a module that merely reaches itself through no
 * edge; only components with at least two members are mutual dependencies.
 */
export function findCycles(graph) {
	const index = new Map();
	const lowLink = new Map();
	const onStack = new Set();
	const stack = [];
	const cycles = [];
	let counter = 0;

	function visit(node) {
		index.set(node, counter);
		lowLink.set(node, counter);
		counter++;
		stack.push(node);
		onStack.add(node);

		for (const next of graph.get(node) ?? []) {
			if (!index.has(next)) {
				visit(next);
				lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(next)));
			} else if (onStack.has(next)) {
				lowLink.set(node, Math.min(lowLink.get(node), index.get(next)));
			}
		}

		if (lowLink.get(node) !== index.get(node)) return;
		const component = [];
		let member;
		do {
			member = stack.pop();
			onStack.delete(member);
			component.push(member);
		} while (member !== node);
		if (component.length > 1) cycles.push(component);
	}

	for (const node of graph.keys()) {
		if (!index.has(node)) visit(node);
	}
	return cycles;
}

/** Every module participating in any cycle, sorted for stable comparison. */
export function cyclicModules(cycles) {
	return [...new Set(cycles.flat())].sort();
}

/**
 * Compare the measured cyclic set against the frozen one.
 *
 * Violations are modules newly stuck in a cycle. Tightenings are modules that
 * escaped, which never fail the build.
 */
export function evaluateCycles(current, baseline) {
	const frozen = new Set(baseline);
	const measured = new Set(current);
	return {
		tightenings: baseline.filter((module) => !measured.has(module)).sort(),
		violations: current.filter((module) => !frozen.has(module)).sort(),
	};
}

/** Every shipped TypeScript module under `packages/(asterisk)/src`, repo-relative. */
export function collectModules() {
	const modules = [];
	const packagesDir = join(repoRoot, "packages");
	if (!existsSync(packagesDir)) return modules;

	for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		walk(join(packagesDir, pkg.name, "src"), `packages/${pkg.name}/src`, modules);
	}
	return modules;
}

function walk(absoluteDir, relativeDir, out) {
	let entries;
	try {
		entries = readdirSync(absoluteDir, { withFileTypes: true });
	} catch {
		return; // A package without a src/ tree contributes nothing.
	}
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const relative = `${relativeDir}/${entry.name}`;
		if (entry.isDirectory()) walk(join(absoluteDir, entry.name), relative, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(relative);
	}
}

/** Measure the repository's cyclic modules. */
export function measureCyclicModules() {
	const modules = collectModules();
	const readSource = (path) => {
		const absolute = join(repoRoot, path);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
	};
	return cyclicModules(findCycles(buildImportGraph(modules, readSource)));
}

/**
 * Read the frozen baseline at the trust boundary.
 *
 * A missing file is the first run and freezes nothing. A file that exists but
 * does not parse is a corrupted ratchet: refuse with a diagnostic instead of
 * defaulting to an empty baseline, which would report every already-frozen
 * module as a new violation and bury the real problem.
 */
function readBaseline() {
	if (!existsSync(baselinePath)) return { exists: false, modules: [] };

	let parsed;
	try {
		parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
	} catch (error) {
		return { error: `cannot parse ${baselinePath}: ${error instanceof Error ? error.message : String(error)}` };
	}

	const modules = parsed?.modules;
	if (!Array.isArray(modules) || modules.some((module) => typeof module !== "string")) {
		return { error: `${baselinePath} must contain { "modules": string[] }` };
	}
	return { exists: true, modules };
}

function runCli(argv) {
	const baseline = readBaseline();
	if (baseline.error !== undefined) {
		console.error(baseline.error);
		return 1;
	}

	const current = measureCyclicModules();
	const { violations, tightenings } = evaluateCycles(current, baseline.modules);

	if (argv.includes("--update")) {
		// Seeding a first baseline records reality; widening an existing one hides
		// a regression, so only the latter is refused.
		if (baseline.exists && violations.length > 0) {
			console.error("Refusing to widen the cycle baseline. Break these cycles instead:\n");
			for (const module of violations) console.error(`  - ${module}`);
			return 1;
		}
		writeFileSync(baselinePath, `${JSON.stringify({ modules: current }, null, "\t")}\n`);
		console.log(`Import-cycle baseline written: ${current.length} module(s) inside cycles.`);
		return 0;
	}

	if (violations.length > 0) {
		console.error("New import cycles:\n");
		for (const module of violations) console.error(`  - ${module}`);
		console.error("\nA module may not join an import cycle. Invert the dependency or extract the shared part.");
		return 1;
	}

	const suffix = tightenings.length > 0 ? ` ${tightenings.length} escaped — run with --update to tighten.` : "";
	console.log(`Import cycles OK: ${current.length} module(s) held at baseline.${suffix}`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = runCli(process.argv.slice(2));
}
