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

interface PluginFixture {
	readonly version: string;
	readonly source: string;
	readonly dependencyVersion?: string;
	readonly peerDependencies?: Record<string, string>;
}

async function writePluginPackage(pluginsNodeModules: string, name: string, fixture: PluginFixture): Promise<string> {
	const installedDir = path.join(pluginsNodeModules, name);
	await fs.mkdir(path.join(installedDir, "dist"), { recursive: true });
	await Bun.write(
		path.join(installedDir, "package.json"),
		JSON.stringify(
			{
				name,
				version: fixture.version,
				...(fixture.peerDependencies ? { peerDependencies: fixture.peerDependencies } : {}),
				omp: { extensions: ["./dist/extension.ts"] },
			},
			null,
			2,
		),
	);
	await Bun.write(path.join(installedDir, "dist", "extension.ts"), fixture.source);
	return installedDir;
}

describe("PluginManager.install load validation", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-validation-"));
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

	test("rejects an install whose extension entry cannot resolve its dependencies", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "broken-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "1.0.0" } },
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "broken-plugin", {
					version: "1.0.0",
					peerDependencies: { "missing-peer": "^1.0.0" },
					source:
						'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("broken-plugin")).rejects.toThrow(/missing-peer/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies ?? {}).toEqual({});
		expect(await Bun.file(path.join(pluginsNodeModules, "broken-plugin", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).exists()).toBe(false);
	});

	test("restores the previous package tree when reinstall validation fails", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "1.0.0" } }, null, 2),
		);
		await Bun.write(
			path.join(tmpRoot, "omp-plugins.lock.json"),
			JSON.stringify(
				{ plugins: { "broken-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } }, settings: {} },
				null,
				2,
			),
		);
		await writePluginPackage(pluginsNodeModules, "broken-plugin", {
			version: "1.0.0",
			source: 'export default function(pi) { pi.registerCommand("old-ok", { handler: async () => {} }); }\n',
		});

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "broken-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "2.0.0" } },
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "broken-plugin", {
					version: "2.0.0",
					peerDependencies: { "missing-peer": "^1.0.0" },
					source:
						'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("broken-plugin")).rejects.toThrow(/missing-peer/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies).toEqual({ "broken-plugin": "1.0.0" });
		const restoredPackage = await Bun.file(path.join(pluginsNodeModules, "broken-plugin", "package.json")).json();
		expect(restoredPackage.version).toBe("1.0.0");
		const restoredExtension = await Bun.file(
			path.join(pluginsNodeModules, "broken-plugin", "dist", "extension.ts"),
		).text();
		expect(restoredExtension).toContain("old-ok");
		expect(restoredExtension).not.toContain("missing-peer");
		const lock = await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).json();
		expect(lock.plugins["broken-plugin"]).toEqual({ version: "1.0.0", enabledFeatures: null, enabled: true });
	});

	test("restores the previous git plugin tree when reinstalling a different ref fails validation", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin#v1" } },
				null,
				2,
			),
		);
		await Bun.write(
			path.join(tmpRoot, "omp-plugins.lock.json"),
			JSON.stringify(
				{ plugins: { "git-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } }, settings: {} },
				null,
				2,
			),
		);
		await writePluginPackage(pluginsNodeModules, "git-plugin", {
			version: "1.0.0",
			source: 'export default function(pi) { pi.registerCommand("git-old-ok", { handler: async () => {} }); }\n',
		});

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "github:org/plugin#v2"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin#v2" } },
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "git-plugin", {
					version: "2.0.0",
					peerDependencies: { "missing-peer": "^1.0.0" },
					source:
						'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("github:org/plugin#v2")).rejects.toThrow(/missing-peer/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies).toEqual({ "git-plugin": "github:org/plugin#v1" });
		const restoredPackage = await Bun.file(path.join(pluginsNodeModules, "git-plugin", "package.json")).json();
		expect(restoredPackage.version).toBe("1.0.0");
		const restoredExtension = await Bun.file(
			path.join(pluginsNodeModules, "git-plugin", "dist", "extension.ts"),
		).text();
		expect(restoredExtension).toContain("git-old-ok");
		expect(restoredExtension).not.toContain("missing-peer");
		const lock = await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).json();
		expect(lock.plugins["git-plugin"]).toEqual({ version: "1.0.0", enabledFeatures: null, enabled: true });
	});

	test("rejects an install whose manifest declares a missing extension entry", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "partial-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "partial-plugin": "1.0.0" } },
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "partial-plugin");
				await fs.mkdir(path.join(installedDir, "dist"), { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify(
						{
							name: "partial-plugin",
							version: "1.0.0",
							omp: { extensions: ["./dist/valid.ts", "./dist/missing.ts"] },
						},
						null,
						2,
					),
				);
				await Bun.write(
					path.join(installedDir, "dist", "valid.ts"),
					'export default function(pi) { pi.registerCommand("valid-ext", { handler: async () => {} }); }\n',
				);
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("partial-plugin")).rejects.toThrow(/dist\/missing\.ts/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies ?? {}).toEqual({});
		expect(await Bun.file(path.join(pluginsNodeModules, "partial-plugin", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).exists()).toBe(false);
	});
});
