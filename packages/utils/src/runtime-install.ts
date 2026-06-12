import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as Module from "node:module";
import * as path from "node:path";

/**
 * On-demand runtime dependency support for native-heavy optional packages
 * (Transformers.js, fastembed) that are never bundled into the CLI or the
 * compiled binary. Consumers `bun install` a pinned dependency set into a
 * cache directory on first use ({@link ensureRuntimeInstalled}) and load the
 * entrypoint via `createRequire`.
 *
 * Bun's compiled-binary module resolver only finds `<pkg>/index.js` for bare
 * specifiers loaded from the *real* filesystem — it ignores `main`/`exports`
 * (issue #1763). Runtime-installed graphs (`@huggingface/transformers` →
 * `onnxruntime-node` → `onnxruntime-common`, `fastembed` →
 * `@anush008/tokenizers` → platform binding) all point `main`/`exports` at
 * nested files, so the stock resolver cannot load any of them. We patch
 * `Module._resolveFilename` to resolve those bare specifiers against the
 * registered runtime caches ourselves, honoring `main`/`exports`.
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
 * an `import`-only entry).
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

interface ResolverRegistration {
	runtimeNodeModules: string;
	stubs: Record<string, string>;
}

const REGISTRY = Symbol.for("omp.runtimeModuleResolver.registry");
const PATCHED = Symbol.for("omp.runtimeModuleResolver.patched");

/**
 * The registration list lives on `globalThis` so a bundled copy and a
 * source copy of this module in one process share the same registry — the
 * resolver is patched once per process, and the patched closure must see
 * every registration.
 */
function resolverRegistry(): ResolverRegistration[] {
	const holder = globalThis as { [REGISTRY]?: ResolverRegistration[] };
	holder[REGISTRY] ??= [];
	return holder[REGISTRY];
}

export interface RuntimeResolverOptions {
	/** Absolute path to the runtime cache's `node_modules`. */
	runtimeNodeModules: string;
	/** Bare specifier → absolute file path overrides (e.g. `sharp` → no-op stub). */
	stubs?: Record<string, string>;
}

/**
 * Patch `node:module`'s resolver (idempotently) so bare specifiers that the
 * stock compiled-binary resolver cannot find fall back to the registered
 * runtime caches. Stock resolution is tried first, so this never changes
 * behavior for modules that already resolve (bundled imports, node builtins).
 * Multiple runtime roots may register; they are consulted in registration
 * order.
 */
export function installRuntimeModuleResolver({ runtimeNodeModules, stubs = {} }: RuntimeResolverOptions): void {
	const registry = resolverRegistry();
	const existing = registry.find(entry => entry.runtimeNodeModules === runtimeNodeModules);
	if (existing) Object.assign(existing.stubs, stubs);
	else registry.push({ runtimeNodeModules, stubs: { ...stubs } });

	const resolver = (Module as unknown as { default?: ModuleResolver } & ModuleResolver).default ?? Module;
	const target = resolver as unknown as ModuleResolver & { [PATCHED]?: boolean };
	if (target[PATCHED]) return;
	const original = target._resolveFilename.bind(target);
	target._resolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown): string => {
		try {
			return original(request, parent, isMain, options);
		} catch (error) {
			for (const registration of resolverRegistry()) {
				const stub = registration.stubs[request];
				if (stub) return stub;
				const resolved = resolveRuntimeModule(registration.runtimeNodeModules, request);
				if (resolved) return resolved;
			}
			throw error;
		}
	};
	target[PATCHED] = true;
}

/** Pinned dependency set materialized into a runtime cache directory. */
export interface RuntimeInstallSpec {
	dependencies: Record<string, string>;
	/** Packages whose lifecycle scripts bun may run during the install. */
	trustedDependencies?: string[];
}

export type RuntimeInstallPhase = "initiate" | "download" | "done";

export interface EnsureRuntimeInstalledOptions {
	/** Directory owning the runtime `package.json` + `node_modules`. */
	runtimeDir: string;
	install: RuntimeInstallSpec;
	/** Package whose installed manifest marks the runtime complete; defaults to the first dependency. */
	probePackage?: string;
	/** Phase notifications (progress UI); not emitted when already installed. */
	onPhase?: (phase: RuntimeInstallPhase) => void;
	lockAttempts?: number;
	lockSleepMs?: number;
}

function isErrnoCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function acquireInstallLock(runtimeDir: string, attempts: number, sleepMs: number): Promise<() => Promise<void>> {
	const lockDir = `${runtimeDir}.lock`;
	await fsp.mkdir(path.dirname(lockDir), { recursive: true });
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await fsp.mkdir(lockDir);
			return async () => {
				await fsp.rm(lockDir, { recursive: true, force: true });
			};
		} catch (error) {
			if (!isErrnoCode(error, "EEXIST")) throw error;
			await Bun.sleep(sleepMs);
		}
	}
	throw new Error(`Timed out waiting for runtime install lock: ${lockDir}`);
}

async function writeRuntimeManifest(runtimeDir: string, install: RuntimeInstallSpec): Promise<void> {
	await fsp.mkdir(runtimeDir, { recursive: true });
	const manifest: Record<string, unknown> = {
		private: true,
		type: "module",
		dependencies: install.dependencies,
	};
	if (install.trustedDependencies?.length) manifest.trustedDependencies = install.trustedDependencies;
	await Bun.write(path.join(runtimeDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

async function runRuntimeInstall(runtimeDir: string): Promise<void> {
	// `process.execPath` is plain bun in source/bundle mode and the compiled
	// binary otherwise; BUN_BE_BUN makes the compiled binary act as bun.
	const proc = Bun.spawn([process.execPath, "install", "--cwd", runtimeDir, "--production"], {
		env: { ...Bun.env, BUN_BE_BUN: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipe(proc.stdout as ReadableStream<Uint8Array> | null),
		readPipe(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	if (exitCode === 0) return;
	const output = `${stdout}\n${stderr}`.trim();
	throw new Error(
		`Failed to install runtime at ${runtimeDir} with ${process.execPath} install (exit ${exitCode}): ${output}`,
	);
}

/**
 * Materialize a pinned dependency set into `runtimeDir` (idempotent,
 * cross-process safe via a lock directory). Returns `runtimeDir`.
 */
export async function ensureRuntimeInstalled(options: EnsureRuntimeInstalledOptions): Promise<string> {
	const { runtimeDir, install, onPhase, lockAttempts = 240, lockSleepMs = 250 } = options;
	let probePackage = options.probePackage;
	if (!probePackage) {
		for (const name in install.dependencies) {
			probePackage = name;
			break;
		}
	}
	if (!probePackage) throw new Error(`Runtime install at ${runtimeDir} declares no dependencies`);
	const probeManifest = Bun.file(path.join(runtimeDir, "node_modules", ...probePackage.split("/"), "package.json"));
	if (await probeManifest.exists()) return runtimeDir;

	onPhase?.("initiate");
	const releaseLock = await acquireInstallLock(runtimeDir, lockAttempts, lockSleepMs);
	try {
		if (await probeManifest.exists()) return runtimeDir;
		await writeRuntimeManifest(runtimeDir, install);
		onPhase?.("download");
		await runRuntimeInstall(runtimeDir);
		onPhase?.("done");
		return runtimeDir;
	} finally {
		await releaseLock();
	}
}
