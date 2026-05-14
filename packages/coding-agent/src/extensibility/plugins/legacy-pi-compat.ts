import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@oh-my-pi";

// Scopes that have historically been used to publish (or alias) the same set
// of internal pi-* packages. `@oh-my-pi` is intentionally included so that
// direct imports of the canonical name still flow through `Bun.resolveSync`
// against the host binary, avoiding a duplicate copy being pulled in from a
// plugin's own node_modules tree at install time.
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
const LEGACY_PI_FILE_PREFIX = "omp-legacy-pi-file:";
const LEGACY_PI_FILE_NAMESPACE = "omp-legacy-pi-file";
const resolvedSpecifierFallbacks = new Map<string, string>();

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

			return `${prefix}${toImportSpecifier(getResolvedSpecifier(remappedSpecifier))}${suffix}`;
		},
	);
}

// Match static `from "..."` / `from '...'` import specifiers.
const STATIC_IMPORT_SPECIFIER_REGEX = /(from\s+["'])([^"']+)(["'])/g;
// Match static imports plus dynamic `import("...")` / `import('...')` specifiers.
const ANY_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])([^"']+)(["'])/g;

/** Resolve bare imports against the extension directory before loading mirrored legacy Pi files. */
function isUrlLikeSpecifier(specifier: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);
}

function shouldPreserveImportSpecifier(specifier: string): boolean {
	return specifier.startsWith(".") || path.isAbsolute(specifier) || isUrlLikeSpecifier(specifier);
}

function toRewrittenImportSpecifier(resolvedPath: string): string {
	return isUrlLikeSpecifier(resolvedPath) ? resolvedPath : toImportSpecifier(resolvedPath);
}

function rewriteBareImportsForLegacyExtension(source: string, importerPath: string): string {
	const importerDir = path.dirname(importerPath);
	return source.replace(ANY_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		// Skip relative, absolute, URL-style, and already-resolved Node specifiers.
		if (shouldPreserveImportSpecifier(specifier)) {
			return match;
		}
		try {
			const resolved = Bun.resolveSync(specifier, importerDir);
			return `${prefix}${toRewrittenImportSpecifier(resolved)}${suffix}`;
		} catch {
			return match;
		}
	});
}

interface LegacyPiMirrorState {
	root: string;
	seen: Map<string, string>;
}

function getMirrorPath(sourcePath: string, state: LegacyPiMirrorState): string {
	const extension = path.extname(sourcePath) || ".js";
	const digest = Bun.hash(sourcePath).toString(36);
	return path.join(state.root, `${digest}${extension}`);
}

async function rewriteRelativeImportsForLegacyExtension(
	source: string,
	importerPath: string,
	state: LegacyPiMirrorState,
): Promise<string> {
	const replacements = new Map<string, string>();

	for (const match of source.matchAll(STATIC_IMPORT_SPECIFIER_REGEX)) {
		const specifier = match[2];
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			continue;
		}

		const resolved = Bun.resolveSync(specifier, path.dirname(importerPath));
		const mirrored = await mirrorLegacyPiFile(resolved, state);
		replacements.set(specifier, toImportSpecifier(mirrored));
	}

	if (replacements.size === 0) {
		return source;
	}

	return source.replace(STATIC_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		const replacement = replacements.get(specifier);
		return replacement ? `${prefix}${replacement}${suffix}` : match;
	});
}

async function rewriteLegacyPiImportsForRuntime(
	source: string,
	importerPath: string,
	state: LegacyPiMirrorState,
): Promise<string> {
	const withRelativeResolved = await rewriteRelativeImportsForLegacyExtension(source, importerPath, state);
	const withLegacyRemap = rewriteLegacyPiImports(withRelativeResolved);
	return rewriteBareImportsForLegacyExtension(withLegacyRemap, importerPath);
}

async function mirrorLegacyPiFile(sourcePath: string, state: LegacyPiMirrorState): Promise<string> {
	const resolvedPath = path.resolve(sourcePath);
	const cached = state.seen.get(resolvedPath);
	if (cached) {
		return cached;
	}

	const mirrorPath = getMirrorPath(resolvedPath, state);
	state.seen.set(resolvedPath, mirrorPath);

	const raw = await Bun.file(resolvedPath).text();
	const rewritten = await rewriteLegacyPiImportsForRuntime(raw, resolvedPath, state);
	await Bun.write(mirrorPath, rewritten);
	return mirrorPath;
}

export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	const root = path.join(os.tmpdir(), "omp-legacy-pi-file", Bun.hash(resolvedPath).toString(36));
	await fs.rm(root, { recursive: true, force: true });
	const state: LegacyPiMirrorState = { root, seen: new Map() };
	const mirroredEntry = await mirrorLegacyPiFile(resolvedPath, state);
	return import(`${toImportSpecifier(mirroredEntry)}?mtime=${Date.now()}`);
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

function resolveLegacyPiSpecifier(args: { path: string }): { path: string } | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	return {
		path: getResolvedSpecifier(remappedSpecifier),
	};
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
			build.onResolve(
				{ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: LEGACY_PI_FILE_NAMESPACE },
				resolveLegacyPiSpecifier,
			);

			build.onResolve({ filter: /^omp-legacy-pi-file:/, namespace: "file" }, args => ({
				path: args.path.slice(LEGACY_PI_FILE_PREFIX.length),
				namespace: LEGACY_PI_FILE_NAMESPACE,
			}));

			build.onResolve({ filter: /^(?:\.{1,2}\/|\/)/, namespace: LEGACY_PI_FILE_NAMESPACE }, args => ({
				path: args.path.startsWith("/") ? args.path : Bun.resolveSync(args.path, path.dirname(args.importer)),
				namespace: LEGACY_PI_FILE_NAMESPACE,
			}));

			build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: LEGACY_PI_FILE_NAMESPACE }, async args => {
				const raw = await Bun.file(args.path).text();
				const withLegacyRemap = rewriteLegacyPiImports(raw);
				const withBareResolved = rewriteBareImportsForLegacyExtension(withLegacyRemap, args.path);
				return {
					contents: withBareResolved,
					loader: getLoader(args.path),
				};
			});
		},
	});
}
