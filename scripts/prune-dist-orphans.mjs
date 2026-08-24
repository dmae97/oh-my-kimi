/**
 * Remove build outputs whose source no longer exists.
 *
 * `tsgo` writes into `dist/` but never deletes outputs for sources that were
 * removed, and plain `npm run build` does not clean first (only `prepublishOnly`
 * does). A deleted module therefore keeps a live `dist/*.js` that `omk` and the
 * RPC tests still load — a stale build that fails with confusing module-loader
 * errors long after the source is gone.
 *
 * The rule is source-derived, not a path allowlist: a compiled artifact is an
 * orphan when no source file could have produced it. `dist/x.js` is kept when
 * either `src/x.ts` (compiled) or `src/x.js` (copied asset) exists, so vendored
 * JS and copied templates survive without being special-cased.
 *
 * Usage:
 *   node scripts/prune-dist-orphans.mjs [packageRoot] [--dry-run]
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories copied wholesale into dist; their contents have no 1:1 source mapping. */
const COPIED_TREES = new Set(["docs", "examples"]);

/** Extensions tsgo emits. Anything else in dist is a copied asset. */
const COMPILED_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js"];

/** Strip the compiled suffix, returning the source-relative base path. */
export function compiledBase(relativePath) {
	for (const suffix of COMPILED_SUFFIXES) {
		if (relativePath.endsWith(suffix)) return relativePath.slice(0, -suffix.length);
	}
	return undefined;
}

/**
 * True when no source could have produced this artifact. `.ts` covers compiled
 * output; `.js` covers assets copied verbatim out of `src`.
 */
export function isOrphan(relativePath, sourceExists) {
	const base = compiledBase(relativePath);
	if (base === undefined) return false;
	return !sourceExists(`${base}.ts`) && !sourceExists(`${base}.js`);
}

function collectFiles(directory, root, out) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const child = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (COPIED_TREES.has(relative(root, child))) continue;
			collectFiles(child, root, out);
			continue;
		}
		if (entry.isFile()) out.push(relative(root, child).replace(/\\/g, "/"));
	}
	return out;
}

/** Orphaned dist artifacts for one package, as dist-relative paths. */
export function findDistOrphans(packageRoot) {
	const distRoot = join(packageRoot, "dist");
	const sourceRoot = join(packageRoot, "src");
	if (!existsSync(distRoot) || !existsSync(sourceRoot)) return [];
	const sourceExists = (candidate) => {
		const path = join(sourceRoot, candidate);
		return existsSync(path) && statSync(path).isFile();
	};
	return collectFiles(distRoot, distRoot, []).filter((file) => isOrphan(file, sourceExists));
}

function main(argv) {
	const dryRun = argv.includes("--dry-run");
	const packageRoot = resolve(argv.find((arg) => !arg.startsWith("--")) ?? process.cwd());
	const orphans = findDistOrphans(packageRoot);

	if (orphans.length === 0) {
		console.log("No stale build outputs.");
		return 0;
	}
	for (const orphan of orphans) {
		if (!dryRun) rmSync(join(packageRoot, "dist", orphan), { force: true });
		console.log(`${dryRun ? "stale" : "removed"}: dist/${orphan}`);
	}
	console.log(`${dryRun ? "Found" : "Removed"} ${orphans.length} stale build output(s).`);
	return dryRun ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
