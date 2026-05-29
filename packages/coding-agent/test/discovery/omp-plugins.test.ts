/**
 * Regression tests for #1496.
 *
 * The native `omp` discovery provider only walks `.omp/` and `~/.omp/agent/`.
 * Extension packages registered via `extensions:` in settings or
 * `--extension` on the CLI ship their own `skills/`, `hooks/`, `tools/`,
 * `commands/`, `rules/`, `prompts/`, and `.mcp.json`. The `omp-plugins`
 * provider (`src/discovery/omp-plugins.ts`) is what wires those sub-trees
 * into the standard capability surfaces.
 *
 * The provider is invoked directly so the `LoadContext` uses a tempdir as
 * `home` instead of `os.homedir()`. Module-level CLI injection state is
 * reset between cases so they cannot poison each other.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { promptCapability } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import type { LoadContext, Provider } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";

const PROVIDER_ID = "omp-plugins";

let tempDir: string;
let home: string;
let project: string;
let ext: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function pluginProvider(capabilityId: string): Provider<unknown> {
	const cap = getCapability(capabilityId);
	if (!cap) throw new Error(`capability ${capabilityId} missing`);
	const provider = cap.providers.find(p => p.id === PROVIDER_ID);
	if (!provider) throw new Error(`provider ${PROVIDER_ID} not registered for ${capabilityId}`);
	return provider as Provider<unknown>;
}

async function loadFromPlugin<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const result = await pluginProvider(capabilityId).load(ctx);
	return result.items as T[];
}

function buildExtensionPackage(packageDir: string): void {
	writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./src/main.ts"] } }),
	);
	writeFile(path.join(packageDir, "src", "main.ts"), "export default function (_pi) {}\n");
	writeFile(
		path.join(packageDir, "skills", "my-skill", "SKILL.md"),
		"---\nname: my-skill\ndescription: Hello from extension skill\n---\nbody\n",
	);
	writeFile(path.join(packageDir, "commands", "greet.md"), "---\ndescription: greet user\n---\nHello {{name}}\n");
	writeFile(path.join(packageDir, "rules", "style.md"), "---\ndescription: style rule\n---\nUse tabs.\n");
	writeFile(path.join(packageDir, "prompts", "review.md"), "Review this code.\n");
	writeFile(path.join(packageDir, "hooks", "pre", "bash.sh"), "#!/bin/sh\necho pre\n");
	writeFile(path.join(packageDir, "hooks", "post", "edit.sh"), "#!/bin/sh\necho post\n");
	writeFile(path.join(packageDir, "tools", "wcount.sh"), "#!/bin/sh\nwc -w\n");
	writeFile(path.join(packageDir, "tools", "deep-tool", "index.ts"), "export default { name: 'deep-tool' };\n");
	writeFile(
		path.join(packageDir, ".mcp.json"),
		JSON.stringify({ mcpServers: { lsp: { command: "lsp-server", args: ["--stdio"] } } }),
	);
}

beforeEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-plugins-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	ext = path.join(tempDir, "my-extension");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	buildExtensionPackage(ext);
});

afterEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function ctx(): LoadContext {
	return { cwd: project, home, repoRoot: project };
}

test("project settings.json#extensions surfaces every sub-directory", async () => {
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const [skills, commands, rules, prompts, hooks, tools, mcps] = await Promise.all([
		loadFromPlugin<{ name: string }>(skillCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(slashCommandCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(ruleCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(promptCapability.id, ctx()),
		loadFromPlugin<{ name: string; type: "pre" | "post" }>(hookCapability.id, ctx()),
		loadFromPlugin<{ name: string }>(toolCapability.id, ctx()),
		loadFromPlugin<{ name: string; command?: string }>(mcpCapability.id, ctx()),
	]);

	expect(skills.map(s => s.name)).toContain("my-skill");
	expect(commands.map(c => c.name)).toContain("greet");
	expect(rules.map(r => r.name)).toContain("style");
	expect(prompts.map(p => p.name)).toContain("review");
	expect(hooks.some(h => h.name === "bash.sh" && h.type === "pre")).toBe(true);
	expect(hooks.some(h => h.name === "edit.sh" && h.type === "post")).toBe(true);
	expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["wcount", "deep-tool"]));
	expect(mcps.find(m => m.name === "lsp")?.command).toBe("lsp-server");
});

test("user settings.json#extensions also feeds sub-discovery", async () => {
	writeFile(path.join(home, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test("`--extension` CLI injection is wired through the same provider", async () => {
	// Empty settings on disk; rely purely on CLI injection.
	injectOmpExtensionCliRoots([ext], home, project);

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	const tools = await loadFromPlugin<{ name: string }>(toolCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
	expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["wcount", "deep-tool"]));
});

test("file-extension entrypoints contribute zero sub-surface (the file has no siblings to scan)", async () => {
	const standaloneFile = path.join(tempDir, "standalone.ts");
	fs.writeFileSync(standaloneFile, "export default function (_pi) {}\n");
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [standaloneFile] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills).toHaveLength(0);
});

test("relative paths in settings resolve against the project cwd", async () => {
	// Move the extension under the project root so a relative path is meaningful.
	const relative = "vendored/my-extension";
	const target = path.join(project, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(ext, target, { recursive: true });
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [`./${relative}`] }));

	const skills = await loadFromPlugin<{ name: string }>(skillCapability.id, ctx());
	expect(skills.map(s => s.name)).toContain("my-skill");
});

test(".mcp.json with bare entries (no command/url) records a warning and is skipped", async () => {
	writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({ mcpServers: { broken: {}, ok: { command: "x", args: [] } } }),
	);
	writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const result = await pluginProvider(mcpCapability.id).load(ctx());
	expect(result.items.map(s => (s as { name: string }).name)).toEqual(["ok"]);
	expect((result.warnings ?? []).some(w => w.includes('"broken"'))).toBe(true);
});
