import * as path from "node:path";

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

function rewriteLegacyPiImports(source: string): string {
	return source.replace(
		LEGACY_PI_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const remappedSpecifier = remapLegacyPiSpecifier(specifier);
			if (!remappedSpecifier) {
				return match;
			}

			return `${prefix}${getResolvedSpecifier(remappedSpecifier)}${suffix}`;
		},
	);
}

// Match `from "..."`, `from '...'`, `import("...")`, `import('...')` import specifiers.
const ANY_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])([^"']+)(["'])/g;

/**
 * Resolves bare module specifiers in a legacy-namespaced extension source file
 * to absolute paths anchored at the extension's own directory. Without this,
 * imports inside files loaded via the `omp-legacy-pi-file:` namespace bypass
 * Node-style node_modules lookup, so an extension cannot use its own deps.
 * Relative paths and already-resolved absolute paths are left untouched.
 */
function rewriteBareImportsForLegacyExtension(source: string, importerPath: string): string {
	const importerDir = path.dirname(importerPath);
	return source.replace(ANY_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		// Skip relative, absolute, URL-style, and already-resolved Node specifiers.
		if (
			specifier.startsWith(".") ||
			specifier.startsWith("/") ||
			specifier.startsWith("node:") ||
			specifier.includes("://")
		) {
			return match;
		}
		try {
			const resolved = Bun.resolveSync(specifier, importerDir);
			return `${prefix}${resolved}${suffix}`;
		} catch {
			return match;
		}
	});
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
				// Bare specifiers (e.g. "lodash", "@scope/pkg/sub") imported from a legacy-namespaced
				// extension file would otherwise bypass Node-style node_modules lookup because the
				// importer lives in a custom namespace. Pre-resolve them to absolute paths so the
				// extension's own node_modules are honored.
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
