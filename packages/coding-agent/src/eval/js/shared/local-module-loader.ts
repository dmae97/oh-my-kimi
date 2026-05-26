import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { collectModuleSourceSpecifiers, stripTypeScriptSyntax } from "./rewrite-imports";

interface LocalModuleEntry {
	version: number;
	identifier: string;
	module: vm.SourceTextModule;
}

export type LocalImportResolution = { mode: "local"; value: unknown } | { mode: "external"; target: string };

const LOCAL_MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);

export class LocalModuleLoader {
	#context: vm.Context;
	#sessionTag: string;
	#moduleMtimes = new Map<string, number>();
	#moduleDeps = new Map<string, Set<string>>();
	#moduleParents = new Map<string, Set<string>>();
	#moduleVersions = new Map<string, number>();
	#moduleEntries = new Map<string, LocalModuleEntry>();
	#moduleBuilds = new Map<string, Promise<LocalModuleEntry>>();
	#externalModules = new Map<string, Promise<vm.Module>>();
	#requireCache = new Map<string, NodeJS.Require>();

	constructor(sessionId: string) {
		this.#context = vm.createContext(globalThis);
		this.#sessionTag = Bun.hash(sessionId).toString(16);
	}

	async resolveForRun(cwd: string, source: string): Promise<LocalImportResolution> {
		this.#refreshTrackedLocalModules();
		return await this.#resolveFromBase(cwd, source);
	}

	async resolveForModule(moduleUrl: string, source: string, cwd: string): Promise<LocalImportResolution> {
		this.#refreshTrackedLocalModules();
		const modulePath = this.filenameForUrl(moduleUrl);
		const baseDir = modulePath ? path.dirname(modulePath) : cwd;
		return await this.#resolveFromBase(baseDir, source);
	}

	requireForFile(moduleUrlOrPath: string | undefined, cwd: string): NodeJS.Require {
		const basePath = this.filenameForUrl(moduleUrlOrPath) ?? path.join(cwd, "[eval]");
		let cached = this.#requireCache.get(basePath);
		if (!cached) {
			cached = buildRequire(basePath);
			this.#requireCache.set(basePath, cached);
		}
		return cached;
	}

	filenameForUrl(moduleUrlOrPath: string | undefined): string | null {
		if (!moduleUrlOrPath) return null;
		if (moduleUrlOrPath.startsWith("file://")) return fileURLToPath(moduleUrlOrPath);
		return path.isAbsolute(moduleUrlOrPath) ? moduleUrlOrPath : null;
	}

	dirnameForUrl(moduleUrlOrPath: string | undefined, cwd: string): string {
		const filename = this.filenameForUrl(moduleUrlOrPath);
		return filename ? path.dirname(filename) : cwd;
	}

	async #resolveFromBase(baseDir: string, source: string): Promise<LocalImportResolution> {
		const resolved = resolveImportSpecifier(baseDir, source);
		if (isLocalPathSpecifier(source) && isManagedLocalModulePath(resolved)) {
			const entry = await this.#ensureLocalModule(resolved);
			return { mode: "local", value: entry.module.namespace };
		}
		return { mode: "external", target: normalizeImportTarget(resolved) };
	}

	async #ensureLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const existing = this.#moduleEntries.get(modulePath);
		if (existing) return existing;
		const building = this.#moduleBuilds.get(modulePath);
		if (building) return await building;
		const buildPromise = this.#buildLocalModule(modulePath).finally(() => {
			if (this.#moduleBuilds.get(modulePath) === buildPromise) this.#moduleBuilds.delete(modulePath);
		});
		this.#moduleBuilds.set(modulePath, buildPromise);
		return await buildPromise;
	}

	async #buildLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const rawSource = fs.readFileSync(modulePath, "utf8");
		const stripped = stripTypeScriptSyntax(rawSource);
		const moduleDir = path.dirname(modulePath);
		const localDeps = new Set<string>();
		for (const specifier of collectModuleSourceSpecifiers(stripped)) {
			const resolved = resolveImportSpecifier(moduleDir, specifier);
			if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
				localDeps.add(resolved);
			}
		}
		this.#setModuleDependencies(modulePath, localDeps);
		this.#moduleMtimes.set(modulePath, fs.statSync(modulePath).mtimeMs);
		const version = this.#moduleVersions.get(modulePath) ?? 1;
		this.#moduleVersions.set(modulePath, version);
		const fileUrl = pathToFileURL(modulePath).href;
		const identifier = `${fileUrl}?omp-session=${this.#sessionTag}&v=${version}`;
		const wrappedSource = buildModuleSource(stripped, modulePath);
		const module = new vm.SourceTextModule(wrappedSource, {
			context: this.#context,
			identifier,
			initializeImportMeta: meta => {
				(meta as { url?: string; path?: string; dir?: string }).url = fileUrl;
				(meta as { url?: string; path?: string; dir?: string }).path = modulePath;
				(meta as { url?: string; path?: string; dir?: string }).dir = moduleDir;
			},
			importModuleDynamically: async specifier => {
				return await this.#resolveLinkedModule(modulePath, String(specifier));
			},
		});
		const entry: LocalModuleEntry = { version, identifier, module };
		this.#moduleEntries.set(modulePath, entry);
		try {
			await module.link(async specifier => await this.#resolveLinkedModule(modulePath, specifier));
			await module.evaluate();
			return entry;
		} catch (error) {
			this.#moduleEntries.delete(modulePath);
			throw error;
		}
	}

	async #resolveLinkedModule(referrerPath: string, specifier: string): Promise<vm.Module> {
		const baseDir = path.dirname(referrerPath);
		const resolved = resolveImportSpecifier(baseDir, specifier);
		if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
			return (await this.#ensureLocalModule(resolved)).module;
		}
		return await this.#ensureExternalModule(normalizeImportTarget(resolved));
	}

	async #ensureExternalModule(target: string): Promise<vm.Module> {
		const existing = this.#externalModules.get(target);
		if (existing) return await existing;
		const loadPromise = (async () => {
			const namespace = await import(target);
			const exportNames = Object.keys(namespace);
			const module = new vm.SyntheticModule(
				exportNames,
				function () {
					for (const name of exportNames) {
						this.setExport(name, namespace[name as keyof typeof namespace]);
					}
				},
				{ context: this.#context, identifier: target },
			);
			await module.link(() => {
				throw new Error("Synthetic external modules have no dependencies");
			});
			await module.evaluate();
			return module;
		})();
		this.#externalModules.set(target, loadPromise);
		try {
			return await loadPromise;
		} catch (error) {
			if (this.#externalModules.get(target) === loadPromise) this.#externalModules.delete(target);
			throw error;
		}
	}

	#refreshTrackedLocalModules(): void {
		const changed: string[] = [];
		for (const [modulePath, previousMtime] of this.#moduleMtimes.entries()) {
			let nextMtime: number | undefined;
			try {
				nextMtime = fs.statSync(modulePath).mtimeMs;
			} catch {
				nextMtime = undefined;
			}
			if (nextMtime === previousMtime) continue;
			if (nextMtime === undefined) this.#moduleMtimes.delete(modulePath);
			else this.#moduleMtimes.set(modulePath, nextMtime);
			changed.push(modulePath);
		}
		for (const modulePath of changed) {
			this.#invalidateModuleAndParents(modulePath, new Set());
		}
	}

	#invalidateModuleAndParents(modulePath: string, seen: Set<string>): void {
		if (seen.has(modulePath)) return;
		seen.add(modulePath);
		this.#moduleEntries.delete(modulePath);
		this.#moduleBuilds.delete(modulePath);
		this.#moduleVersions.set(modulePath, (this.#moduleVersions.get(modulePath) ?? 1) + 1);
		const parents = [...(this.#moduleParents.get(modulePath) ?? [])];
		for (const parent of parents) this.#invalidateModuleAndParents(parent, seen);
	}

	#setModuleDependencies(modulePath: string, deps: Set<string>): void {
		const previousDeps = this.#moduleDeps.get(modulePath);
		if (previousDeps) {
			for (const dep of previousDeps) {
				const parents = this.#moduleParents.get(dep);
				if (!parents) continue;
				parents.delete(modulePath);
				if (parents.size === 0) this.#moduleParents.delete(dep);
			}
		}
		this.#moduleDeps.set(modulePath, new Set(deps));
		for (const dep of deps) {
			const parents = this.#moduleParents.get(dep) ?? new Set<string>();
			parents.add(modulePath);
			this.#moduleParents.set(dep, parents);
		}
	}
}

function buildRequire(fromPath: string): NodeJS.Require {
	const basePath = path.extname(fromPath) ? fromPath : path.join(fromPath, "[eval]");
	return createRequire(pathToFileURL(basePath).href);
}

function buildModuleSource(source: string, modulePath: string): string {
	const moduleDir = path.dirname(modulePath);
	return [
		`const require = globalThis.__omp_get_require__(${JSON.stringify(pathToFileURL(modulePath).href)});`,
		`const __filename = ${JSON.stringify(modulePath)};`,
		`const __dirname = ${JSON.stringify(moduleDir)};`,
		source,
	].join("\n");
}

function resolveImportSpecifier(cwd: string, source: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
	try {
		return Bun.resolveSync(source, cwd);
	} catch {
		return source;
	}
}

function isLocalPathSpecifier(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source === "." ||
		source === ".." ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}

function isManagedLocalModulePath(target: string): boolean {
	return (
		path.isAbsolute(target) &&
		LOCAL_MODULE_EXTENSIONS.has(path.extname(target)) &&
		!target.includes(`${path.sep}node_modules${path.sep}`)
	);
}

function normalizeImportTarget(target: string): string {
	if (path.isAbsolute(target)) return pathToFileURL(target).href;
	return target;
}
