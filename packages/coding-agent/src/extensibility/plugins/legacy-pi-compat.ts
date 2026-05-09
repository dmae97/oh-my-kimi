import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const LEGACY_PI_PACKAGE_MAP = {
	"@mariozechner/pi-agent-core": "@oh-my-pi/pi-agent-core",
	"@mariozechner/pi-ai": "@oh-my-pi/pi-ai",
	"@mariozechner/pi-coding-agent": "@oh-my-pi/pi-coding-agent",
	"@mariozechner/pi-tui": "@oh-my-pi/pi-tui",
} as const;

const LEGACY_PI_CODING_AGENT_SUBPATH_MAP = {
	"extensibility/extensions": "@oh-my-pi/pi-coding-agent/extensibility/extensions",
	"extensibility/hooks": "@oh-my-pi/pi-coding-agent/extensibility/hooks",
} as const;

const LEGACY_PI_SPECIFIER_FILTER = /^@mariozechner\/pi-(agent-core|ai|coding-agent|tui)(\/.*)?$/;
const LEGACY_PI_IMPORT_SPECIFIER_REGEX =
	/((?:from\s+|import\s*\(\s*)["'])(@mariozechner\/pi-(?:agent-core|ai|coding-agent|tui)(?:\/[^"'()\s]+)?)(["'])/g;
const LEGACY_PI_FILE_PREFIX = "omp-legacy-pi-file:";
const LEGACY_PI_FILE_NAMESPACE = "omp-legacy-pi-file";
const resolvedSpecifierFallbacks = new Map<string, string>();

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	const [legacyScope, packageName, ...subpathParts] = specifier.split("/");
	const legacyPackageName = `${legacyScope}/${packageName}`;
	const mappedPackageName = LEGACY_PI_PACKAGE_MAP[legacyPackageName as keyof typeof LEGACY_PI_PACKAGE_MAP];
	if (!mappedPackageName) {
		return null;
	}
	if (subpathParts.length === 0) {
		return mappedPackageName;
	}

	const subpath = subpathParts.join("/");
	if (legacyPackageName === "@mariozechner/pi-coding-agent") {
		return (
			LEGACY_PI_CODING_AGENT_SUBPATH_MAP[subpath as keyof typeof LEGACY_PI_CODING_AGENT_SUBPATH_MAP] ??
			`${mappedPackageName}/${subpath}`
		);
	}

	return `${mappedPackageName}/${subpath}`;
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

// Match `from "..."`, `from '...'`, `import("...")`, `import('...')` import specifiers.
const ANY_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])([^"']+)(["'])/g;

/** Resolve bare imports against the extension directory before loading mirrored legacy Pi files. */
function isUrlLikeSpecifier(specifier: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);
}

function rewriteBareImportsForLegacyExtension(source: string, importerPath: string): string {
	const importerDir = path.dirname(importerPath);
	return source.replace(ANY_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		// Skip relative, absolute, URL-style, and already-resolved Node specifiers.
		if (specifier.startsWith(".") || path.isAbsolute(specifier) || isUrlLikeSpecifier(specifier)) {
			return match;
		}
		try {
			const resolved = Bun.resolveSync(specifier, importerDir);
			return `${prefix}${toImportSpecifier(resolved)}${suffix}`;
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

	for (const match of source.matchAll(ANY_IMPORT_SPECIFIER_REGEX)) {
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

	return source.replace(ANY_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
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
