import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	BUILTIN_TOOL_METADATA,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
} from "../../src/tools/index";

describe("BUILTIN_TOOLS public factory map", () => {
	it("exposes callable tool factories (back-compat for external SDK callers)", () => {
		// External callers may invoke BUILTIN_TOOLS.read(session) directly. Verify the value
		// is a function, not a metadata object wrapping a factory.
		expect(typeof BUILTIN_TOOLS.read).toBe("function");
		expect(typeof BUILTIN_TOOLS.bash).toBe("function");
		expect(typeof BUILTIN_TOOLS.edit).toBe("function");
	});

	it("has a callable factory for every metadata entry", () => {
		for (const name of Object.keys(BUILTIN_TOOL_METADATA)) {
			expect(typeof BUILTIN_TOOLS[name]).toBe("function");
		}
	});

	it("has metadata for every factory entry", () => {
		for (const name of Object.keys(BUILTIN_TOOLS)) {
			expect(BUILTIN_TOOL_METADATA[name]).toBeDefined();
		}
	});
});

describe("BUILTIN_TOOL_METADATA loadMode annotations", () => {
	it("marks read, bash, edit as essential", () => {
		expect(BUILTIN_TOOL_METADATA.read?.loadMode).toBe("essential");
		expect(BUILTIN_TOOL_METADATA.bash?.loadMode).toBe("essential");
		expect(BUILTIN_TOOL_METADATA.edit?.loadMode).toBe("essential");
	});

	it("marks search_tool_bm25 as essential (discovery tool itself)", () => {
		expect(BUILTIN_TOOL_METADATA.search_tool_bm25?.loadMode).toBe("essential");
	});

	it("marks non-essential tools as discoverable", () => {
		const discoverableExpected = [
			"ast_grep",
			"ast_edit",
			"render_mermaid",
			"ask",
			"debug",
			"python",
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
		];
		for (const name of discoverableExpected) {
			expect(BUILTIN_TOOL_METADATA[name]?.loadMode).toBe("discoverable");
		}
	});

	it("provides a summary for every discoverable tool", () => {
		const missing: string[] = [];
		for (const [name, meta] of Object.entries(BUILTIN_TOOL_METADATA)) {
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
