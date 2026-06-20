import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { renderToolInventory } from "../src/dialect/inventory";
import type { InbandTool } from "../src/dialect/types";

const searchTool: InbandTool = {
	name: "web_search",
	description: "Searches the web.",
	parameters: type({
		query: type("string").describe("search query"),
		"recency?": type("'day' | 'week'"),
	}),
	examples: [{ caption: "Basic", call: { query: "rust" } }],
};

describe("renderToolInventory", () => {
	it("renders a tool block with a TypeScript signature and native-syntax examples", () => {
		const out = renderToolInventory([searchTool], "claude-3-5-sonnet-20241022");
		expect(out).toContain("# Tool: web_search");
		expect(out).toContain("Searches the web.");
		expect(out).toContain("Parameters: {");
		expect(out).toContain("query: string;");
		expect(out).toContain('recency?: "day" | "week";');
		expect(out).toContain("<examples>");
		// Examples render in the model's native (anthropic) tool-call syntax.
		expect(out).toContain('<invoke name="web_search">');
	});

	it("omits the examples block when a tool has none", () => {
		const tool: InbandTool = {
			name: "noop",
			description: "No examples.",
			parameters: type({ x: type("string") }),
		};
		const out = renderToolInventory([tool], "claude-3-5-sonnet-20241022");
		expect(out).toContain("Parameters: {");
		expect(out).not.toContain("<examples>");
	});

	it("returns an empty string when there are no tools", () => {
		expect(renderToolInventory([], "claude-3-5-sonnet-20241022")).toBe("");
	});

	it("demotes description headers by one level when a top-level `# ` header is present", () => {
		const tool: InbandTool = {
			name: "read",
			description: ["Reads files.", "", "## Parameters", "", "- `path`", "", "# Files", "", "Stuff."].join("\n"),
			parameters: type({ path: type("string") }),
		};
		const out = renderToolInventory([tool], "claude-3-5-sonnet-20241022");
		// The wrapper heading stays at level 1; description headers drop one level.
		expect(out).toContain("# Tool: read");
		expect(out).toContain("\n### Parameters");
		expect(out).toContain("\n## Files");
		// No level-1 header survives inside the description body.
		expect(out).not.toContain("\n# Files");
	});

	it("leaves descriptions untouched when no top-level `# ` header is present", () => {
		const tool: InbandTool = {
			name: "noop",
			description: ["Does nothing.", "", "## Parameters", "", "- `x`"].join("\n"),
			parameters: type({ x: type("string") }),
		};
		const out = renderToolInventory([tool], "claude-3-5-sonnet-20241022");
		expect(out).toContain("\n## Parameters");
		expect(out).not.toContain("\n### Parameters");
	});

	it("never rewrites headers inside fenced code blocks", () => {
		const tool: InbandTool = {
			name: "shell",
			description: ["Runs commands.", "", "# Usage", "", "```bash", "# not a header", "ls", "```"].join("\n"),
			parameters: type({ cmd: type("string") }),
		};
		const out = renderToolInventory([tool], "claude-3-5-sonnet-20241022");
		expect(out).toContain("\n## Usage");
		// The `#` comment inside the code fence is preserved verbatim.
		expect(out).toContain("\n# not a header");
	});
});
