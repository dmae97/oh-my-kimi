import * as path from "node:path";

/**
 * Recursively substitute ${CLAUDE_PLUGIN_ROOT} and ${OMP_PLUGIN_ROOT}
 * with the actual plugin root path in strings, arrays, and plain objects.
 */
// Use concatenation to avoid noTemplateCurlyInString lint rule on literal placeholder names
const CLAUDE_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";
const OMP_VAR = "$" + "{OMP_PLUGIN_ROOT}";

export function substitutePluginRoot<T>(value: T, rootPath: string): T {
	if (typeof value === "string") {
		return value.replaceAll(CLAUDE_VAR, rootPath).replaceAll(OMP_VAR, rootPath) as T;
	}
	if (Array.isArray(value)) {
		return value.map(v => substitutePluginRoot(v, rootPath)) as T;
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			Object.defineProperty(result, k, {
				value: substitutePluginRoot(v, rootPath),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result as T;
	}
	return value;
}

/**
 * Rebase relative filesystem values in a discovered plugin stdio config against
 * the directory of the `.mcp.json`/`config.toml` that declared them.
 *
 * External plugin configs (bundled ChatGPT/Codex plugins, Claude marketplace
 * plugins) express `command`/`cwd` relative to their own config file, but MCP
 * stdio spawning roots relative values at the session cwd — so a plugin shipping
 * `command: "./bin/server"`, `cwd: "."` launches from the wrong directory and
 * fails with ENOENT. This resolves those against `configDir` instead:
 *
 * - relative `cwd` → resolved against `configDir`;
 * - path-like `command` (`./`, `../`, or the Windows `.\`/`..\` forms) →
 *   resolved against the rooted `cwd` when one is given, else `configDir`.
 *   The transport spawns the subprocess with the rooted `cwd` as its process
 *   cwd (see `mcp/transports/stdio.ts`), so the OS resolves a relative command
 *   from there — e.g. `cwd = "server"`, `command = "./bin/mcp"` must resolve to
 *   `<configDir>/server/bin/mcp`, not `<configDir>/bin/mcp`;
 * - bare executables (`npx`, `uvx`, …) and absolute paths are left untouched.
 */
export function resolvePluginStdioPaths(
	config: { command?: string; cwd?: string },
	configDir: string,
): { command?: string; cwd?: string } {
	const resolved: { command?: string; cwd?: string } = {};
	if (typeof config.cwd === "string") {
		resolved.cwd = path.isAbsolute(config.cwd) ? config.cwd : path.resolve(configDir, config.cwd);
	}
	if (config.command !== undefined) {
		const isPathLike = /^\.\.?[/\\]/.test(config.command);
		// Path-like commands resolve from the rooted cwd (the subprocess's actual
		// working directory) when set, otherwise from the config directory.
		const commandBase = resolved.cwd ?? configDir;
		resolved.command = isPathLike ? path.resolve(commandBase, config.command) : config.command;
	}
	return resolved;
}
