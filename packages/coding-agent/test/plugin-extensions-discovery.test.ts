import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getAgentDir, getPluginsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const currentPiCodingAgentPath = Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
const currentPiExtensionsPath = Bun.resolveSync("@oh-my-pi/pi-coding-agent/extensibility/extensions", import.meta.dir);

describe("plugin extension discovery", () => {
	let projectDir: TempDir;
	let tempXdgDataHome = "";
	let originalXdgDataHome: string | undefined;
	const originalAgentDir = getAgentDir();

	beforeEach(() => {
		projectDir = TempDir.createSync("@pi-plugin-ext-");
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		tempXdgDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-data-"));
		fs.mkdirSync(path.join(tempXdgDataHome, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = tempXdgDataHome;
		// Rebuild path caches after changing XDG env so plugin discovery resolves into the temp root.
		setAgentDir(originalAgentDir);

		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "@demo", "plugin");
		fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"@demo/plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "@demo/plugin",
				version: "1.0.0",
				omp: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "dist", "extension.ts"),
			`
				export default function(pi) {
					pi.registerCommand("plugin-ext", { handler: async () => {} });
				}
			`,
		);
	});

	afterEach(() => {
		projectDir.removeSync();
		fs.rmSync(tempXdgDataHome, { recursive: true, force: true });
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		setAgentDir(originalAgentDir);
	});

	it("loads installed plugin extensions declared in package.json", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path.endsWith(path.join("dist", "extension.ts")));

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("plugin-ext")).toBe(true);
	});

	it("loads installed legacy Pi plugin extensions from Windows drive-letter paths", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "legacy-pi-plugin");
		const extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.rmSync(path.join(pluginsDir, "node_modules"), { recursive: true, force: true });
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: {
					"legacy-pi-plugin": "1.0.0",
				},
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
				'import * as nodePath from "path";',
				'import { isToolCallEventType as legacyRoot } from "@mariozechner/pi-coding-agent";',
				'import { isToolCallEventType as legacyExtensions } from "@mariozechner/pi-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentPiCodingAgentPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				'if (typeof nodePath.join !== "function") throw new Error("node builtin import did not resolve");',
				"",
				"export default function(pi) {",
				"\tconst { Type } = pi.typebox;",
				"\tpi.registerTool({",
				'\t\tname: "legacy-pi-ext",',
				'\t\tdescription: "Legacy Pi extension smoke test",',
				"\t\tparameters: Type.Object({}),",
				'\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"\t});",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		if (process.platform === "win32") {
			expect(extensionPath).toMatch(/^[A-Za-z]:\\/);
		}
		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.tools.has("legacy-pi-ext")).toBe(true);
	});
});
