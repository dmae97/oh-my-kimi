/**
 * Plugin loader - discovers and loads manifest entry points from installed plugins.
 *
 * Reads enabled plugins from the runtime config and loads their
 * tools/hooks/extensions/commands based on manifest entries and enabled features.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsLockfile, getPluginsNodeModules, getPluginsPackageJson, isEnoent } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "../../config";
import { installLegacyPiSpecifierShim } from "./legacy-pi-compat";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

installLegacyPiSpecifierShim();

// =============================================================================
// Runtime Config Loading
// =============================================================================

/**
 * Load plugin runtime config from lock file.
 *
 * `home` controls which `<plugins>/omp-plugins.lock.json` is read — pass it
 * through whenever the caller is loading plugins for a tempdir-rooted
 * scenario (tests, discovery sub-surfaces that need to mirror an alternate
 * `LoadContext.home`).
 */
async function loadRuntimeConfig(home?: string): Promise<PluginRuntimeConfig> {
	const lockPath = getPluginsLockfile(home);
	try {
		return await Bun.file(lockPath).json();
	} catch (err) {
		if (isEnoent(err)) return { plugins: {}, settings: {} };
		throw err;
	}
}

/**
 * Load project-local plugin overrides (checks .omp and .pi directories).
 */
async function loadProjectOverrides(cwd: string): Promise<ProjectPluginOverrides> {
	for (const overridesPath of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			// JSON parse error - continue to next path
		}
	}
	return {};
}
/**
 * Get list of enabled plugins with their resolved configurations.
 *
 * Respects both global runtime config and project overrides. Iterates the
 * union of `<plugins>/package.json#dependencies` (`bun install`-installed
 * packages) and `<plugins>/omp-plugins.lock.json#plugins` (so locally
 * `plugin link`-symlinked extensions, which never get a dependency entry,
 * are still discovered). The optional `home` parameter pins the plugins
 * root for callers that need to enumerate plugins relative to a non-default
 * home (tests with a tempdir, discovery loaders threaded with
 * `LoadContext.home`).
 */
export async function getEnabledPlugins(cwd: string, opts: { home?: string } = {}): Promise<InstalledPlugin[]> {
	const { home } = opts;

	const nodeModulesPath = getPluginsNodeModules(home);
	if (!fs.existsSync(nodeModulesPath)) {
		return [];
	}

	let depsKeys: string[] = [];
	const pkgJsonPath = getPluginsPackageJson(home);
	try {
		const pkg: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
		depsKeys = Object.keys(pkg.dependencies ?? {});
	} catch (err) {
		// Linked-only setups may have no `<plugins>/package.json` yet — that's
		// fine, the lockfile still records the link.
		if (!isEnoent(err)) throw err;
	}

	const runtimeConfig = await loadRuntimeConfig(home);
	const projectOverrides = await loadProjectOverrides(cwd);

	// Union: dependencies (npm/marketplace installs) ∪ runtime-config plugins
	// (links + already-recorded installs). Set preserves first-seen order,
	// putting deps before link-only entries for deterministic output.
	const names = new Set<string>(depsKeys);
	for (const name of Object.keys(runtimeConfig.plugins ?? {})) {
		names.add(name);
	}

	const plugins: InstalledPlugin[] = [];
	for (const name of names) {
		const pluginPkgPath = path.join(nodeModulesPath, name, "package.json");
		let pluginPkg: { version: string; omp?: PluginManifest; pi?: PluginManifest };
		try {
			pluginPkg = await Bun.file(pluginPkgPath).json();
		} catch (err) {
			// Lockfile entry without a corresponding node_modules tree means the
			// link was deleted out from under us; skip silently.
			if (isEnoent(err)) continue;
			throw err;
		}

		const manifest: PluginManifest | undefined = pluginPkg.omp || pluginPkg.pi;
		if (!manifest) {
			// Not an omp plugin, skip
			continue;
		}
		manifest.version = pluginPkg.version;

		const runtimeState = runtimeConfig.plugins[name];

		// Check if disabled globally
		if (runtimeState && !runtimeState.enabled) {
			continue;
		}

		// Check if disabled in project
		if (projectOverrides.disabled?.includes(name)) {
			continue;
		}

		// Resolve enabled features (project overrides take precedence)
		const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;
		plugins.push({
			name,
			version: pluginPkg.version,
			path: path.join(nodeModulesPath, name),
			manifest,
			enabledFeatures,
			enabled: true,
		});
	}

	return plugins;
}

// =============================================================================
// Path Resolution
// =============================================================================

const MANIFEST_ENTRY_INDEX_NAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/**
 * Resolve a plugin manifest entry to a concrete loadable file path. Returns the
 * file path itself when the entry points at a file, the matching index file when
 * the entry points at a directory containing index.{ts,js,mjs,cjs}, and null
 * when no entry exists at the joined path.
 */
function resolveManifestEntryFile(joined: string): string | null {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(joined);
	} catch {
		return null;
	}
	if (stats.isDirectory()) {
		for (const name of MANIFEST_ENTRY_INDEX_NAMES) {
			const candidate = path.join(joined, name);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	}
	return joined;
}

/**
 * Generic path resolver for plugin manifest entries (tools, hooks, commands, extensions).
 * Handles both single-string and string[] base entries, plus feature-specific entries.
 */
function resolvePluginPaths(plugin: InstalledPlugin, key: "tools" | "hooks" | "commands" | "extensions"): string[] {
	const resolved: string[] = [];
	for (const entry of resolvePluginManifestEntries(plugin, key)) {
		if (entry.resolvedPath) {
			resolved.push(entry.resolvedPath);
		}
	}
	return resolved;
}

/**
 * Declared manifest entries paired with their resolved file path. Returns one
 * record per declared entry — base entries first, then enabled-feature entries
 * — so callers (e.g. install-time validation) can detect manifest entries that
 * point at missing files instead of silently skipping them like
 * {@link resolvePluginPaths} does.
 */
export function resolvePluginManifestEntries(
	plugin: InstalledPlugin,
	key: "tools" | "hooks" | "commands" | "extensions",
): Array<{ entry: string; resolvedPath: string | null }> {
	const declared: Array<{ entry: string; resolvedPath: string | null }> = [];
	const manifest = plugin.manifest;

	const resolveEntry = (entry: string): { entry: string; resolvedPath: string | null } => ({
		entry,
		resolvedPath: resolveManifestEntryFile(path.join(plugin.path, entry)),
	});

	const base = manifest[key];
	if (base) {
		const entries = Array.isArray(base) ? base : [base];
		for (const entry of entries) {
			declared.push(resolveEntry(entry));
		}
	}

	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);
		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;
			if (feat[key]) {
				for (const entry of feat[key]) {
					declared.push(resolveEntry(entry));
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;
			if (feat[key]) {
				for (const entry of feat[key]) {
					declared.push(resolveEntry(entry));
				}
			}
		}
	}

	return declared;
}

export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "tools");
}

export function resolvePluginHookPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "hooks");
}

export function resolvePluginCommandPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "commands");
}

export function resolvePluginExtensionPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "extensions");
}

// =============================================================================
// Aggregated Discovery
// =============================================================================

/**
 * Get all tool paths from all enabled plugins.
 */
export async function getAllPluginToolPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

/**
 * Get all hook paths from all enabled plugins.
 */
export async function getAllPluginHookPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginHookPaths(plugin));
	}

	return paths;
}

/**
 * Get all command paths from all enabled plugins.
 */
export async function getAllPluginCommandPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginCommandPaths(plugin));
	}

	return paths;
}

/**
 * Get all extension module paths from all enabled plugins.
 */
export async function getAllPluginExtensionPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginExtensionPaths(plugin));
	}

	return paths;
}

/**
 * Get plugin settings for use in tool/hook contexts.
 * Merges global settings with project overrides.
 */
export async function getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
