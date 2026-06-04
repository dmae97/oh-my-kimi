import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";

const IS_COMPILED_BINARY = isCompiledBinary();

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@oh-my-pi";

// Scopes that have historically been used to publish (or alias) the same set
// of internal pi-* packages. `@oh-my-pi` is intentionally included so direct
// canonical imports still pass through the same host-bundled package resolution
// path instead of pulling a duplicate copy from plugin node_modules.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;

// Internal pi-* package basenames bundled inside the omp binary.
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;

const PI_SCOPE_ALTERNATION = PI_SCOPE_ALIASES.join("|");
const PI_PACKAGE_ALTERNATION = PI_PACKAGE_NAMES.join("|");

// Upstream `@mariozechner/*` packages exposed a few subpaths at the package
// root that we relocated under a different folder. Each entry rewrites
// `<pkg>/<from>` → `<pkg>/<to>` after the scope has been canonicalised, so
// plugins importing the upstream layout still resolve to a real file in our
// bundled copy. Add new entries as `pkg/from -> pkg/to` whenever a plugin
// surfaces another upstream-only subpath that breaks resolution.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	// `@mariozechner/pi-ai/oauth` re-exported `./utils/oauth/index.js`.
	// Our pi-ai keeps the implementation under `utils/oauth` but never added a
	// root-level re-export, so map the upstream subpath onto it directly.
	["pi-ai/oauth", "pi-ai/utils/oauth"],
]);

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
const LEGACY_PI_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s*\\(\\s*)["'])(@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const resolvedSpecifierFallbacks = new Map<string, string>();
const SOURCE_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const PACKAGE_IMPORT_CONDITIONS = ["bun", "import", "default", "types"] as const;
const packageRootCache = new Map<string, string | null>();
const packageImportsCache = new Map<string, Record<string, unknown> | null>();

// Extensions that imported `@sinclair/typebox` directly used to resolve against a
// real `@sinclair/typebox` install. The runtime dep was replaced with the Zod-backed
// shim under `extensibility/typebox.ts`; plugins still importing the public name
// are redirected to that shim so existing extensions keep working without code
// changes. Submodules like `@sinclair/typebox/compiler` are intentionally not
// remapped — those expose TypeBox-only APIs the shim does not provide and plugins
// relying on them must vendor `@sinclair/typebox` directly.
const TYPEBOX_SPECIFIER_FILTER = /^@sinclair\/typebox$/;

// Compat shim and bundled-package paths used in compiled-binary mode. The shim
// paths must point at files that ship inside the bunfs root; in dev /
// source-link / installed-package mode the canonical specifier resolves via
// `Bun.resolveSync` so only the shim files need explicit paths there.
//
// `BUNFS_PACKAGE_ROOT` is derived from `import.meta.dir` rather than hardcoded
// as `/$bunfs/root/packages` so the prefix stays platform-native: on Windows
// the bunfs mount appears as `<drive>:\~BUN\root\…` (see oven-sh/bun#15766),
// and a hardcoded POSIX literal would normalize to `\$bunfs\root\…` and fail
// to resolve. Compiled Bun modules currently report the bunfs root itself from
// `import.meta.dir`, so appending `packages` lands on the `--root ../..`
// package directory used by `scripts/build-binary.ts`.
//
// Every shim listed below must also be registered as an explicit `--compile`
// entrypoint in `scripts/build-binary.ts` or release builds fail with
// missing-module errors. Non-shim bundled packages are resolved via
// `Bun.resolveSync` (see `resolveCanonicalPiSpecifier`) outside compiled mode,
// so they keep working when on-disk layout differs from the monorepo tree.
/**
 * Compute the bunfs package root from the compiled binary's `import.meta.dir`
 * (or any stand-in supplied by tests). Bun 1.3 reports the bunfs mount root
 * (`/$bunfs/root` or `<drive>:\~BUN\root`) for imported modules as well as the
 * entrypoint, so the normal path is `<root>/packages`.
 *
 * The suffix branch preserves correctness if a future Bun release switches to
 * module-specific `import.meta.dir` values inside compiled binaries, matching
 * the source layout:
 * `<bunfs>/packages/coding-agent/src/extensibility/plugins`.
 *
 * Exported for tests; production callers use `BUNFS_PACKAGE_ROOT` below.
 */
export function __computeBunfsPackageRoot(metaDir: string, pathImpl: typeof path = path): string {
	const pluginsDirSuffix = pathImpl.join("packages", "coding-agent", "src", "extensibility", "plugins");
	const normalizedMetaDir = pathImpl.normalize(metaDir);
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return pathImpl.resolve(metaDir, "..", "..", "..", "..");
	}
	return pathImpl.join(metaDir, "packages");
}

const BUNFS_PACKAGE_ROOT = IS_COMPILED_BINARY ? __computeBunfsPackageRoot(import.meta.dir) : null;

function bunfsPath(...segments: string[]): string {
	if (!BUNFS_PACKAGE_ROOT) {
		throw new Error("bunfsPath is only valid in compiled-binary mode");
	}
	return path.join(BUNFS_PACKAGE_ROOT, ...segments);
}

const TYPEBOX_SHIM_PATH = BUNFS_PACKAGE_ROOT
	? bunfsPath("coding-agent", "src", "extensibility", "typebox.js")
	: path.resolve(import.meta.dir, "../typebox.ts");

// Legacy extensions historically imported `Type` (and `Static`/`TSchema`) from
// the package root of `@(scope)/pi-ai`. pi-ai 15.1.0 removed the runtime `Type`
// export (see `packages/ai/CHANGELOG.md`), so the bare canonical specifier no
// longer satisfies those imports. The override below redirects only the bare
// pi-ai package root onto a sibling shim that re-exports the canonical surface
// plus the borrowed `Type` runtime from the Zod-backed TypeBox shim. Subpath
// imports such as `@oh-my-pi/pi-ai/utils/oauth` continue to resolve directly
// against the bundled pi-ai package.
const LEGACY_PI_AI_SHIM_PATH = BUNFS_PACKAGE_ROOT
	? bunfsPath("coding-agent", "src", "extensibility", "legacy-pi-ai-shim.js")
	: path.resolve(import.meta.dir, "../legacy-pi-ai-shim.ts");

// The coding-agent's own `./src/index.ts` cannot be listed as an extra
// `bun --compile` entrypoint alongside the CLI entry without breaking binary
// startup (issue #1474 follow-up). Legacy `@(scope)/pi-coding-agent` root
// imports therefore resolve through a sibling shim whose distinct file path
// avoids that collision while re-exporting the canonical package surface.
const LEGACY_PI_CODING_AGENT_SHIM_PATH = BUNFS_PACKAGE_ROOT
	? bunfsPath("coding-agent", "src", "extensibility", "legacy-pi-coding-agent-shim.js")
	: path.resolve(import.meta.dir, "../legacy-pi-coding-agent-shim.ts");

// Package-root overrides. Shim entries are always applied because they replace
// (or augment) the canonical surface even in non-compiled installs. The bunfs
// entries are added only in compiled-binary mode — in dev / source-link /
// installed-package mode the canonical specifier resolves cleanly through
// `Bun.resolveSync`, and hardcoding a relative source-tree path would break
// installs where the bundled packages live at `node_modules/@oh-my-pi/pi-*`
// rather than `packages/*`.
const LEGACY_PI_PACKAGE_ROOT_OVERRIDES: Record<string, string> = {
	[`${CANONICAL_PI_SCOPE}/pi-ai`]: LEGACY_PI_AI_SHIM_PATH,
	[`${CANONICAL_PI_SCOPE}/pi-coding-agent`]: LEGACY_PI_CODING_AGENT_SHIM_PATH,
	...(BUNFS_PACKAGE_ROOT
		? {
				[`${CANONICAL_PI_SCOPE}/pi-agent-core`]: bunfsPath("agent", "src", "index.js"),
				[`${CANONICAL_PI_SCOPE}/pi-natives`]: bunfsPath("natives", "native", "index.js"),
				[`${CANONICAL_PI_SCOPE}/pi-tui`]: bunfsPath("tui", "src", "index.js"),
				[`${CANONICAL_PI_SCOPE}/pi-utils`]: bunfsPath("utils", "src", "index.js"),
			}
		: {}),
};

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = PI_SUBPATH_REMAPS.get(rest) ?? rest;
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

/**
 * Resolve a canonical `@oh-my-pi/*` specifier to a filesystem path, preferring
 * a bundled compat shim when one is registered for the package root.
 *
 * Falls back to `getResolvedSpecifier` (which may throw under compiled binary
 * mode); callers handle that the same way they would for non-overridden
 * specifiers.
 */
function resolveCanonicalPiSpecifier(remappedSpecifier: string): string {
	const override = LEGACY_PI_PACKAGE_ROOT_OVERRIDES[remappedSpecifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(remappedSpecifier);
}

function toImportSpecifier(resolvedPath: string): string {
	return url.pathToFileURL(resolvedPath).href;
}

function rewriteLegacyPiImports(source: string): string {
	return source.replace(
		LEGACY_PI_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const remappedSpecifier = remapLegacyPiSpecifier(specifier);
			if (!remappedSpecifier) {
				return match;
			}

			try {
				return `${prefix}${toImportSpecifier(resolveCanonicalPiSpecifier(remappedSpecifier))}${suffix}`;
			} catch {
				// Resolution failed — typically in compiled binary mode where
				// Bun.resolveSync cannot walk up from /$bunfs/root to find the
				// bundled node_modules. Leave the specifier unchanged so Bun
				// resolves it natively against the extension's own peer deps.
				return match;
			}
		},
	);
}

// Match the bare `@sinclair/typebox` import specifier (static + dynamic).
// Subpath imports like `@sinclair/typebox/compiler` are intentionally excluded —
// they expose TypeBox-only APIs the Zod-backed shim does not provide.
const TYPEBOX_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])(@sinclair\/typebox)(["'])/g;

/**
 * Rewrite the extension-owned specifiers OMP must host-resolve — legacy
 * `@(scope)/pi-*`, bare `@sinclair/typebox`, and package `imports` aliases like
 * `#src/*` — to absolute `file://` URLs. Every other specifier (relative
 * siblings and third-party dependencies) is left untouched so Bun resolves it
 * natively from the extension's real on-disk location.
 */
async function rewriteLegacyExtensionSource(source: string, importerPath: string): Promise<string> {
	const withPi = rewriteLegacyPiImports(source);
	const withTypeBox = withPi.replace(
		TYPEBOX_IMPORT_SPECIFIER_REGEX,
		(_match, prefix: string, _specifier: string, suffix: string) => {
			return `${prefix}${toImportSpecifier(TYPEBOX_SHIM_PATH)}${suffix}`;
		},
	);
	return rewriteExtensionPackageImports(withTypeBox, importerPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveSourceModuleFile(basePath: string): Promise<string | null> {
	try {
		const stats = await fs.stat(basePath);
		if (stats.isFile()) {
			return realpathOrSelf(basePath);
		}
		if (stats.isDirectory()) {
			for (const extension of SOURCE_MODULE_EXTENSIONS) {
				const resolved = await resolveSourceModuleFile(path.join(basePath, `index${extension}`));
				if (resolved) return resolved;
			}
		}
	} catch {
		// Fall through to extension candidates below.
	}

	if (path.extname(basePath)) {
		return null;
	}

	for (const extension of SOURCE_MODULE_EXTENSIONS) {
		const resolved = await resolveSourceModuleFile(`${basePath}${extension}`);
		if (resolved) return resolved;
	}
	return null;
}

async function findPackageRoot(importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const cached = packageRootCache.get(dir);
		if (cached !== undefined) {
			return cached;
		}

		if (await pathExists(path.join(dir, "package.json"))) {
			packageRootCache.set(path.dirname(importerPath), dir);
			return dir;
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			packageRootCache.set(path.dirname(importerPath), null);
			return null;
		}
		dir = parent;
	}
}

async function readPackageImports(packageRoot: string): Promise<Record<string, unknown> | null> {
	const cached = packageImportsCache.get(packageRoot);
	if (cached !== undefined) {
		return cached;
	}

	let imports: Record<string, unknown> | null = null;
	try {
		const pkg = await Bun.file(path.join(packageRoot, "package.json")).json();
		if (isRecord(pkg) && isRecord(pkg.imports)) {
			imports = pkg.imports;
		}
	} catch {
		imports = null;
	}
	packageImportsCache.set(packageRoot, imports);
	return imports;
}

function selectPackageImportTarget(entry: unknown): string | null {
	if (typeof entry === "string") {
		return entry;
	}
	if (Array.isArray(entry)) {
		for (const item of entry) {
			const target = selectPackageImportTarget(item);
			if (target) return target;
		}
		return null;
	}
	if (!isRecord(entry)) {
		return null;
	}
	for (const condition of PACKAGE_IMPORT_CONDITIONS) {
		const target = selectPackageImportTarget(entry[condition]);
		if (target) return target;
	}
	for (const value of Object.values(entry)) {
		const target = selectPackageImportTarget(value);
		if (target) return target;
	}
	return null;
}

async function resolvePackageImportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolveSourceModuleFile(path.resolve(packageRoot, substituted));
}

async function resolvePackageImportSpecifier(specifier: string, importerPath: string): Promise<string | null> {
	if (!specifier.startsWith("#")) {
		return null;
	}

	const packageRoot = await findPackageRoot(importerPath);
	if (!packageRoot) {
		return null;
	}

	const imports = await readPackageImports(packageRoot);
	if (!imports) {
		return null;
	}

	const exactTarget = selectPackageImportTarget(imports[specifier]);
	if (exactTarget) {
		return resolvePackageImportTarget(packageRoot, exactTarget, null);
	}

	let bestMatch: { keyLength: number; target: string; wildcard: string } | null = null;
	for (const [key, entry] of Object.entries(imports)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1) continue;

		const prefix = key.slice(0, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
			continue;
		}

		const target = selectPackageImportTarget(entry);
		if (!target) {
			continue;
		}

		if (!bestMatch || key.length > bestMatch.keyLength) {
			bestMatch = {
				keyLength: key.length,
				target,
				wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
			};
		}
	}

	if (!bestMatch) {
		return null;
	}
	return resolvePackageImportTarget(packageRoot, bestMatch.target, bestMatch.wildcard);
}

const PACKAGE_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])(#[^"'()\s]+)(["'])/g;

async function rewriteExtensionPackageImports(source: string, importerPath: string): Promise<string> {
	let rewritten = "";
	let lastIndex = 0;
	for (const match of source.matchAll(PACKAGE_IMPORT_SPECIFIER_REGEX)) {
		const matchIndex = match.index;
		if (matchIndex === undefined) continue;

		const [fullMatch, prefix, specifier, suffix] = match;
		if (!prefix || !specifier || !suffix) continue;

		const resolved = await resolvePackageImportSpecifier(specifier, importerPath);
		if (!resolved) continue;

		rewritten += source.slice(lastIndex, matchIndex);
		rewritten += `${prefix}${toImportSpecifier(resolved)}${suffix}`;
		lastIndex = matchIndex + fullMatch.length;
	}

	if (lastIndex === 0) {
		return source;
	}
	return `${rewritten}${source.slice(lastIndex)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match source modules in an extension graph (relative imports and package
// `imports` aliases such as `#src/*`). Bare third-party dependencies remain
// native Bun resolutions.
const EXTENSION_GRAPH_SPECIFIER_REGEX = /(?:from\s+|import\s*\(\s*)["']((?:\.\.?\/|#)[^"']+)["']/g;

// Extension entry realpaths that already have a load-time rewrite hook
// installed. Each `Bun.plugin()` registration is process-global and permanent,
// so we register at most one hook per entry.
const hookedExtensionEntries = new Set<string>();

/** Resolve symlinks in a path, falling back to the input if realpath fails. */
async function realpathOrSelf(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return p;
	}
}

/**
 * Walk the extension's relative-import graph starting at `entryRealPath`,
 * returning the realpath of every reachable source module. Only relative
 * specifiers (`./`, `../`) are followed — bare and absolute imports are left to
 * Bun's native resolver — so the set is exactly the extension's own source,
 * wherever it physically lives (a `../src` sibling, a symlinked sub-tree, …).
 * This mirrors the module set the old temp-dir mirror tracked, minus the copy.
 */
async function collectExtensionModules(entryRealPath: string): Promise<Set<string>> {
	const modules = new Set<string>();
	const queue = [entryRealPath];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.add(file);
		const dir = path.dirname(file);
		for (const match of source.matchAll(EXTENSION_GRAPH_SPECIFIER_REGEX)) {
			const specifier = match[1];
			if (!specifier) continue;
			try {
				const resolved = specifier.startsWith("#")
					? await resolvePackageImportSpecifier(specifier, file)
					: await realpathOrSelf(Bun.resolveSync(specifier, dir));
				if (resolved && !modules.has(resolved)) {
					queue.push(resolved);
				}
			} catch {
				// Unresolvable relative import (e.g. a type-only path); skip it.
			}
		}
	}
	return modules;
}

/**
 * Install a `Bun.plugin()` `onLoad` hook scoped to exactly the modules in an
 * extension's source graph, so their legacy `@(scope)/pi-*`, bare
 * `@sinclair/typebox`, and local package-import aliases are rewritten at load
 * time. A runtime `onLoad` cannot fall through (Bun requires a result object),
 * so the filter is an exact-path alternation of the graph's realpaths — it
 * never matches the host, other extensions, `node_modules` deps, or unrelated
 * project source.
 */
async function ensureExtensionGraphHook(entryRealPath: string): Promise<void> {
	if (hookedExtensionEntries.has(entryRealPath)) {
		return;
	}
	hookedExtensionEntries.add(entryRealPath);

	const modules = await collectExtensionModules(entryRealPath);
	const alternation = [...modules].map(escapeRegExp).join("|");
	const filter = new RegExp(`^(?:${alternation})$`);
	Bun.plugin({
		name: `omp:legacy-pi-ext:${Bun.hash(entryRealPath).toString(36)}`,
		setup(build) {
			build.onLoad({ filter, namespace: "file" }, async args => {
				const raw = await Bun.file(args.path).text();
				return { contents: await rewriteLegacyExtensionSource(raw, args.path), loader: getLoader(args.path) };
			});
		},
	});
}

/**
 * Load a legacy Pi extension module from its real on-disk location.
 *
 * The extension runs in place, so its `import.meta.url` is the real source file
 * and `__dirname`-relative `readFileSync` asset loads (HTML/CSS bundled next to
 * the entry) resolve exactly as they do under the original Pi runtime — no
 * temp-directory mirroring and no asset copying. An `onLoad` hook scoped to the
 * entry's source graph rewrites only host-resolved compatibility imports in the
 * extension's own source; everything else resolves natively.
 */
export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	// Bun reports the realpath of a loaded module to `onLoad` and exposes it as
	// `import.meta.url`. Resolve symlinks here too (macOS `/var`→`/private/var`,
	// `bun link`/pnpm installs) so the rewrite filter matches the path Bun
	// actually hands the hook.
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureExtensionGraphHook(entryRealPath);
	// `?mtime` busts Bun's module cache so repeat loads pick up edited source.
	return import(`${toImportSpecifier(entryRealPath)}?mtime=${Date.now()}`);
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string; importer: string }): { path: string } | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	// Primary: resolve the canonical @oh-my-pi/* specifier from the host binary
	// location. Works in dev mode and in source-link installs.
	try {
		return { path: resolveCanonicalPiSpecifier(remappedSpecifier) };
	} catch {
		// Fallback for compiled binary mode: the bundled packages live inside
		// /$bunfs/root and aren't reachable by filesystem resolution. Prefer the
		// canonical specifier against the importing file's directory when the
		// plugin installed @oh-my-pi peer deps, then try the original legacy
		// specifier for plugins that still vendor only @mariozechner or
		// @earendil-works peer deps.
		const importerDir = path.dirname(args.importer);
		try {
			return { path: Bun.resolveSync(remappedSpecifier, importerDir) };
		} catch {
			try {
				return { path: Bun.resolveSync(args.path, importerDir) };
			} catch {
				return undefined;
			}
		}
	}
}

function resolveTypeBoxSpecifier(): { path: string } {
	return { path: TYPEBOX_SHIM_PATH };
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
		},
	});
}

/** Test seam: clears the memoized canonical specifier resolutions. */
export function __resetLegacyPiResolutionCache(): void {
	resolvedSpecifierFallbacks.clear();
}
