/**
 * Install-from-git tests for `PluginManager.install`.
 *
 * Strategy: spy on the six `@oh-my-pi/pi-utils` plugin-path getters so the
 * manager points at a temp directory tree, then spy on `Bun.spawn` so we can
 * simulate `bun install <git-spec>`'s side effects (writing the dep into
 * `plugins/package.json` under its real name, and dropping a matching
 * `node_modules/<name>/package.json`). This exercises the real
 * `PluginManager.install` end-to-end without hitting the network.
 *
 * `vi.spyOn` + `vi.restoreAllMocks()` is the same pattern used by
 * `test/tools/report-tool-issue.test.ts` (which spies on
 * `piUtils.getInstallId`), so we know namespace spying on `pi-utils` exports
 * propagates through to consumers of the barrel re-exports. The
 * `vi.spyOn(Bun, "spawn")` mock follows `test/git-process-config.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) {
		throw new Error("Failed to create empty response stream");
	}
	return body;
}

describe("PluginManager.install with git sources", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-git-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		pluginsPkgJson = path.join(pluginsDir, "package.json");
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(pluginsPkgJson);
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	test("installs from github: shorthand and resolves real package name from deps diff", async () => {
		// Seed the plugins manifest so install()'s `depsBefore` snapshot is empty
		// rather than triggering #ensurePackageJson's bootstrap path.
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
		);

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			// Verify the manager forwards the spec verbatim to bun install.
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("install");
			expect(cmd[2]).toBe("github:foo/bar");

			// Simulate the on-disk side effects bun install produces for a git
			// source: a new dep keyed by the package's own `name` field, plus
			// the corresponding entry under node_modules.
			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: { "real-name": "github:foo/bar" },
						},
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "real-name");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "real-name", version: "0.1.0" }, null, 2),
				);
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("github:foo/bar");

		expect(result.name).toBe("real-name");
		expect(result.version).toBe("0.1.0");
		expect(result.enabled).toBe(true);
		expect(result.path).toBe(path.join(pluginsNodeModules, "real-name"));
	});

	test("normalizes non-GitHub shorthand before invoking bun install", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
		);

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("install");
			expect(cmd[2]).toBe("https://gitlab.com/group/sub/project#v1.0.0");

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: {
								"gitlab-plugin": "git+https://gitlab.com/group/sub/project.git#v1.0.0",
							},
						},
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "gitlab-plugin");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "gitlab-plugin", version: "1.0.0" }, null, 2),
				);
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("gitlab:group/sub/project#v1.0.0");

		expect(result.name).toBe("gitlab-plugin");
		expect(result.version).toBe("1.0.0");
	});

	test("rejects git specs containing shell metacharacters", async () => {
		const mgr = new PluginManager(tmpRoot);
		await expect(mgr.install("github:foo/bar; rm -rf /")).rejects.toThrow(/Invalid characters in plugin source/);
	});

	test("still rejects invalid npm names with the original error", async () => {
		const mgr = new PluginManager(tmpRoot);
		await expect(mgr.install("Invalid Name With Spaces")).rejects.toThrow(/Invalid (package name|characters)/);
	});
});
