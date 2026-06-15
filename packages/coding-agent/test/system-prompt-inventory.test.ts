import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	[
		"bash",
		{
			label: "Bash",
			description: "Executes a shell command.",
			parameters: { type: "object", properties: { command: { type: "string" } } },
		},
	],
]);

describe("system prompt tool inventory", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-inv-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-inv-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(opts: { nativeTools: boolean; repeatToolDescriptions: boolean }): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...opts,
		});
		return systemPrompt.join("\n\n");
	}

	it("renders a compact name list only when native tools are active and descriptions are not repeated", async () => {
		const text = await render({ nativeTools: true, repeatToolDescriptions: false });
		expect(text).toContain("- Read: `read`");
		expect(text).toContain("- Bash: `bash`");
		// No full per-tool sections in list mode.
		expect(text).not.toContain("# Tool: read");
		expect(text).not.toContain("Reads files from disk.");
	});

	it("renders `# Tool:` sections (not a name list) when tools are not native", async () => {
		const text = await render({ nativeTools: false, repeatToolDescriptions: false });
		expect(text).toContain("# Tool: read");
		expect(text).toContain("# Tool: bash");
		expect(text).toContain("Reads files from disk.");
		expect(text).not.toContain("- Read: `read`");
		// The legacy `<tool>` wrapper is gone.
		expect(text).not.toContain("<tool name=");
	});

	it("renders `# Tool:` sections when descriptions are repeated even with native tools", async () => {
		const text = await render({ nativeTools: true, repeatToolDescriptions: true });
		expect(text).toContain("# Tool: read");
		expect(text).toContain("Executes a shell command.");
		expect(text).not.toContain("- Read: `read`");
	});

	it("places the inventory at the bottom of the TOOLS section (after I/O and Exploration)", async () => {
		const text = await render({ nativeTools: true, repeatToolDescriptions: false });
		const inventoryIdx = text.indexOf("# Inventory");
		const ioIdx = text.indexOf("# I/O");
		const explorationIdx = text.indexOf("# Exploration");
		expect(inventoryIdx).toBeGreaterThan(-1);
		expect(ioIdx).toBeGreaterThan(-1);
		expect(explorationIdx).toBeGreaterThan(-1);
		expect(inventoryIdx).toBeGreaterThan(ioIdx);
		expect(inventoryIdx).toBeGreaterThan(explorationIdx);
	});
});
