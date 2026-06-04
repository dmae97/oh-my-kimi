import * as fs from "node:fs";
import * as Module from "node:module";
import * as path from "node:path";

/**
 * Bun's compiled-binary module resolver only finds `<pkg>/index.js` for bare
 * specifiers loaded from the *real* filesystem — it ignores `main`/`exports`
 * (issue #1763). The tiny-model Transformers.js runtime is `bun install`ed into
 * a cache directory at runtime, and its graph (`@huggingface/transformers` →
 * `onnxruntime-node` → `onnxruntime-common`, plus an eager `require("sharp")`)
 * all point `main`/`exports` at nested files, so the stock resolver cannot load
 * any of them. We patch `Module._resolveFilename` to resolve those bare
 * specifiers against the cache ourselves, honoring `main`/`exports`.
 *
 * This module is filesystem-pure aside from {@link installRuntimeModuleResolver}
 * mutating the `node:module` resolver, so the resolution logic is unit-testable
 * without a compiled binary.
 */

/** Conditions honored when resolving an `exports` map for a CommonJS `require`. */
const RUNTIME_CONDITIONS: Record<string, true> = { node: true, require: true, default: true };

/** Extension probes appended to a `main`/`exports` target that lacks one. */
const RUNTIME_EXTENSIONS: readonly string[] = [".js", ".cjs", ".mjs", ".json", ".node"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk a conditional `exports` target (string, array of fallbacks, or a
 * condition object) and return the first relative path that matches a runtime
 * condition in declaration order. Returns `null` when nothing applies (e.g.
 * `import`-only targets).
 */
export function selectConditionalTarget(target: unknown): string | null {
	if (typeof target === "string") return target;
	if (Array.isArray(target)) {
		for (const entry of target) {
			const resolved = selectConditionalTarget(entry);
			if (resolved) return resolved;
		}
		return null;
	}
	if (isRecord(target)) {
		for (const condition in target) {
			if (!RUNTIME_CONDITIONS[condition]) continue;
			const resolved = selectConditionalTarget(target[condition]);
			if (resolved) return resolved;
		}
	}
	return null;
}

/** Resolve a relative target inside a package to a concrete file path, probing extensions and `index`. */
function resolveFileTarget(pkgDir: string, relative: string): string | null {
	const base = path.join(pkgDir, relative);
	const candidates = [base, ...RUNTIME_EXTENSIONS.map(ext => base + ext)];
	for (const candidate of candidates) {
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) return candidate;
			if (stat.isDirectory()) {
				const indexed = resolveFileTarget(candidate, "index");
				if (indexed) return indexed;
			}
		} catch {
			// missing candidate — keep probing
		}
	}
	return null;
}

function resolveExportsEntry(
	pkgDir: string,
	exports: Record<string, unknown>,
	subpath: string | undefined,
): string | null {
	let subpathMap = false;
	for (const key in exports) {
		subpathMap = key === "." || key.startsWith("./");
		break;
	}
	if (subpathMap) {
		const key = subpath ? `./${subpath}` : ".";
		if (!(key in exports)) return null;
		const target = selectConditionalTarget(exports[key]);
		return target ? resolveFileTarget(pkgDir, target) : null;
	}
	// A bare condition map only describes the package root, so a subpath
	// request falls through to plain path joining at the call site.
	if (subpath) return null;
	const target = selectConditionalTarget(exports);
	return target ? resolveFileTarget(pkgDir, target) : null;
}

/**
 * Split a bare specifier into its package name and optional subpath, handling
 * scoped packages (`@scope/name/sub` → `@scope/name` + `sub`).
 */
export function splitBareSpecifier(specifier: string): { packageName: string; subpath: string | undefined } {
	const segments = specifier.split("/");
	const take = specifier.startsWith("@") ? 2 : 1;
	const packageName = segments.slice(0, take).join("/");
	const subpath = segments.length > take ? segments.slice(take).join("/") : undefined;
	return { packageName, subpath };
}

/**
 * Resolve a bare specifier against an installed `node_modules` directory,
 * honoring `exports` (CommonJS conditions), then `main`, then `index.js`.
 * Returns an absolute file path, or `null` when the package/entry is absent.
 */
export function resolveRuntimeModule(runtimeNodeModules: string, specifier: string): string | null {
	const { packageName, subpath } = splitBareSpecifier(specifier);
	const pkgDir = path.join(runtimeNodeModules, ...packageName.split("/"));
	const manifest = readManifest(pkgDir);
	if (!manifest) return subpath ? resolveFileTarget(pkgDir, subpath) : null;

	const { exports } = manifest;
	if (typeof exports === "string" || isRecord(exports)) {
		const map = typeof exports === "string" ? { ".": exports } : exports;
		const resolved = resolveExportsEntry(pkgDir, map, subpath);
		if (resolved) return resolved;
	}
	if (subpath) return resolveFileTarget(pkgDir, subpath);
	if (typeof manifest.main === "string") {
		const resolved = resolveFileTarget(pkgDir, manifest.main);
		if (resolved) return resolved;
	}
	return resolveFileTarget(pkgDir, "index.js");
}

function readManifest(pkgDir: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

interface ModuleResolver {
	_resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
}

const PATCHED = Symbol.for("omp.tiny.compiledRuntimeResolver");

interface ResolverOptions {
	/** Absolute path to the runtime cache's `node_modules`. */
	runtimeNodeModules: string;
	/** Bare specifier → absolute file path overrides (e.g. `sharp` → no-op stub). */
	stubs?: Record<string, string>;
}

/**
 * Patch `node:module`'s resolver (idempotently) so bare specifiers that the
 * stock compiled-binary resolver cannot find fall back to the runtime cache.
 * Stock resolution is tried first, so this never changes behavior for modules
 * that already resolve (the worker's own bundled imports, node builtins).
 */
export function installRuntimeModuleResolver({ runtimeNodeModules, stubs = {} }: ResolverOptions): void {
	const resolver = (Module as unknown as { default?: ModuleResolver } & ModuleResolver).default ?? Module;
	const target = resolver as unknown as ModuleResolver & { [PATCHED]?: boolean };
	if (target[PATCHED]) return;
	const original = target._resolveFilename.bind(target);
	target._resolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown): string => {
		try {
			return original(request, parent, isMain, options);
		} catch (error) {
			const stub = stubs[request];
			if (stub) return stub;
			const resolved = resolveRuntimeModule(runtimeNodeModules, request);
			if (resolved) return resolved;
			throw error;
		}
	};
	target[PATCHED] = true;
}
