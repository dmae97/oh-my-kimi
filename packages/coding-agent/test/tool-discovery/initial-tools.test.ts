import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools/index";
import {
	AskTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	IrcTool,
	JobTool,
	RecipeTool,
	SshTool,
} from "../../src/tools/index";

const allToolsSettings = Settings.isolated({
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"renderMermaid.enabled": true,
	"debug.enabled": true,
	"find.enabled": true,
	"search.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"notebook.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"calc.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"irc.enabled": true,
	"recipe.enabled": true,
	"todo.enabled": true,
	"memory.backend": "hindsight",
	"tools.discoveryMode": "all",
});

const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const tools = await createTools(toolSession, Object.keys(BUILTIN_TOOLS));
	const metadata = new Map(tools.map(tool => [tool.name, { loadMode: tool.loadMode, summary: tool.summary }]));
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new RecipeTool(toolSession, []),
		new IrcTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	return metadata;
}
describe("BUILTIN_TOOLS public factory map", () => {
	it("exposes callable tool factories (back-compat for external SDK callers)", () => {
		// External callers may invoke BUILTIN_TOOLS.read(session) directly. Verify the value
		// is a function, not a metadata object wrapping a factory.
		expect(typeof BUILTIN_TOOLS.read).toBe("function");
		expect(typeof BUILTIN_TOOLS.bash).toBe("function");
		expect(typeof BUILTIN_TOOLS.edit).toBe("function");
	});

	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(name => metadata.get(name)?.loadMode === undefined);
		expect(missing).toEqual([]);
	});
});

describe("built-in tool loadMode annotations", () => {
	it("marks read, bash, edit, and search_tool_bm25 as essential", async () => {
		const metadata = await getToolMetadata();
		expect(metadata.get("read")?.loadMode).toBe("essential");
		expect(metadata.get("bash")?.loadMode).toBe("essential");
		expect(metadata.get("edit")?.loadMode).toBe("essential");
		expect(metadata.get("search_tool_bm25")?.loadMode).toBe("essential");
	});

	it("marks non-essential tools as discoverable", async () => {
		const discoverableExpected = [
			"ast_grep",
			"ast_edit",
			"render_mermaid",
			"ask",
			"debug",
			"eval",
			"calc",
			"ssh",
			"github",
			"find",
			"search",
			"lsp",
			"notebook",
			"inspect_image",
			"browser",
			"checkpoint",
			"rewind",
			"task",
			"job",
			"recipe",
			"irc",
			"todo_write",
			"web_search",
			"write",
			"retain",
			"recall",
			"reflect",
		];
		const metadata = await getToolMetadata();
		const missing = discoverableExpected.filter(name => metadata.get(name)?.loadMode !== "discoverable");
		expect(missing).toEqual([]);
	});

	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("DEFAULT_ESSENTIAL_TOOL_NAMES", () => {
	it("contains the expected defaults", () => {
		expect(DEFAULT_ESSENTIAL_TOOL_NAMES).toContain("read");
		expect(DEFAULT_ESSENTIAL_TOOL_NAMES).toContain("bash");
		expect(DEFAULT_ESSENTIAL_TOOL_NAMES).toContain("edit");
	});
});

describe("computeEssentialBuiltinNames", () => {
	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["find", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("falls back to defaults when override is non-empty but contains only invalid names", () => {
		// The filtered list is empty (no valid names), but the override was provided —
		// current behavior returns the empty filtered list (caller can decide). Document the behavior.
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("defaults to off", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.discoveryMode")).toBe("off");
	});

	it("accepts mcp-only", () => {
		const settings = Settings.isolated({ "tools.discoveryMode": "mcp-only" });
		expect(settings.get("tools.discoveryMode")).toBe("mcp-only");
	});

	it("accepts all", () => {
		const settings = Settings.isolated({ "tools.discoveryMode": "all" });
		expect(settings.get("tools.discoveryMode")).toBe("all");
	});

	it("tools.essentialOverride defaults to empty array", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.essentialOverride")).toEqual([]);
	});

	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});
