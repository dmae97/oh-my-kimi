import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAndLoadExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getAgentDir, getPluginsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const currentPiCodingAgentPath = Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
const currentPiExtensionsPath = Bun.resolveSync("@oh-my-pi/pi-coding-agent/extensibility/extensions", import.meta.dir);

describe("issue #989: legacy Pi plugin imports", () => {
	let projectDir: TempDir;
	let extensionPath: string;
	let originalAgentDir: string;
	let pluginDataDir: TempDir;

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		pluginDataDir = TempDir.createSync("@issue-989-plugins-");
		process.env.XDG_DATA_HOME = pluginDataDir.path();
		fs.mkdirSync(path.join(pluginDataDir.path(), "omp"), { recursive: true });
		setAgentDir(originalAgentDir);

		projectDir = TempDir.createSync("@issue-989-");
		const pluginDir = path.join(getPluginsDir(), "node_modules", "legacy-pi-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(getPluginsDir(), "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: { "legacy-pi-plugin": "1.0.0" },
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "legacy-pi-plugin",
				version: "1.0.0",
				pi: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import { isToolCallEventType as legacyRoot } from "@mariozechner/pi-coding-agent";',
				'import { isToolCallEventType as legacyExtensions } from "@mariozechner/pi-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentPiCodingAgentPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				"",
				"export default function(pi) {",
				'\tpi.registerCommand("legacy-pi-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
		pluginDataDir.removeSync();
		delete process.env.XDG_DATA_HOME;
		setAgentDir(originalAgentDir);
	});

	it("loads plugin extensions that still import legacy @mariozechner Pi packages", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toEqual([]);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("legacy-pi-ext")).toBe(true);
	});

	it("loads legacy Pi plugin entries from Windows drive-letter paths", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(extensionPath).toMatch(/^[A-Za-z]:\\/);
		expect(result.errors).toEqual([]);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("legacy-pi-ext")).toBe(true);
	});
});
