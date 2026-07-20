#!/usr/bin/env bun
/**
 * Rewrite extensionless relative specifiers in emitted `.d.ts` to explicit
 * `.js` extensions so the published declarations resolve under
 * `moduleResolution: "node16" | "nodenext"`.
 *
 * The workspace type-checks under `moduleResolution: "Bundler"`
 * (`tsconfig.base.json`), which permits extensionless relative imports. `tsgo`
 * therefore emits `export * from "./sdk"` / `import … from "./modes/components"`
 * into `dist/types`. A downstream consumer on `nodenext` (the modern default)
 * then can't resolve the barrel — every relative re-export is a `TS2834`, which
 * cascades into `TS2305` "no exported member" on the whole package root.
 *
 * This post-emit pass appends the correct extension to each **relative**
 * specifier, resolving it against the emitted tree:
 *   `./sdk`              → `./sdk.js`               (sibling `sdk.d.ts`)
 *   `./modes/components` → `./modes/components/index.js`  (directory barrel)
 * Bare (`@scope/pkg`, `zod/v4`) and already-suffixed (`.js`, `.json`)
 * specifiers are left untouched.
 *
 * Applied by `ci-release-publish.ts` after `tsgo -p tsconfig.publish.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Matches relative module specifiers in generated declaration import/export forms:
//   from "…", import "…", import("…"), and declare module "…".
// Captures the quote-enclosed module string; we filter to relative ones below.
const SPECIFIER_RE = /(\b(?:from|import|module)\b\s*(?:\(\s*)?)("|')(\.[^"']*)(\2)/g;

/** Resolve an extensionless relative specifier to its `.js` runtime form,
 *  given the directory of the importing `.d.ts`. Returns null to leave as-is. */
export async function resolveDtsSpecifier(fromDir: string, spec: string): Promise<string | null> {
	// Already has a JS/JSON extension, or a declaration extension we map to .js.
	if (/\.(js|json|mjs|cjs)$/.test(spec)) return null;
	if (/\.d\.ts$/.test(spec)) return `${spec.slice(0, -".d.ts".length)}.js`;

	const abs = path.join(fromDir, spec);
	// Sibling declaration file: `./sdk` → `./sdk.js`.
	if (await exists(`${abs}.d.ts`)) return `${spec}.js`;
	// Directory barrel: `./modes/components` → `./modes/components/index.js`.
	if (await exists(path.join(abs, "index.d.ts"))) return `${spec.replace(/\/$/, "")}/index.js`;
	// Unresolved (e.g. an asset or a specifier with no emitted `.d.ts`): leave it.
	return null;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** Rewrite one `.d.ts` file in place. Returns the number of specifiers changed. */
export async function fixDtsFile(filePath: string): Promise<number> {
	const source = await Bun.file(filePath).text();
	const fromDir = path.dirname(filePath);
	let changed = 0;

	// Collect async resolutions first (regex replace can't await), then apply.
	const edits: Array<{ match: string; replacement: string }> = [];
	for (const m of source.matchAll(SPECIFIER_RE)) {
		const [full, prefix, quote, spec] = m;
		const resolved = await resolveDtsSpecifier(fromDir, spec);
		if (resolved && resolved !== spec) {
			edits.push({ match: full, replacement: `${prefix}${quote}${resolved}${quote}` });
		}
	}
	if (edits.length === 0) return 0;

	let out = source;
	for (const { match, replacement } of edits) {
		out = out.replace(match, replacement);
		changed++;
	}
	await Bun.write(filePath, out);
	return changed;
}

/** Walk `dir` recursively and fix every `.d.ts`. Returns totals. */
export async function fixDtsExtensions(dir: string): Promise<{ files: number; specifiers: number }> {
	let files = 0;
	let specifiers = 0;
	const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const n = await fixDtsFile(filePath);
		if (n > 0) {
			files++;
			specifiers += n;
		}
	}
	return { files, specifiers };
}

if (import.meta.main) {
	const target = process.argv[2];
	if (!target) {
		console.error("usage: fix-dts-extensions.ts <dist/types dir>");
		process.exit(1);
	}
	const { files, specifiers } = await fixDtsExtensions(target);
	console.log(`fix-dts-extensions: rewrote ${specifiers} specifiers across ${files} files in ${target}`);
}
