import { describe, expect, it } from "bun:test";
import { z } from "zod/v4";
import { renderToolInventory } from "../src/dialect/inventory";
import type { InbandTool } from "../src/dialect/types";

const searchTool: InbandTool = {
	name: "web_search",
	description: "Searches the web.",
	parameters: z.object({
		query: z.string().describe("search query"),
		recency: z.enum(["day", "week"]).optional(),
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
			parameters: z.object({ x: z.string() }),
		};
		const out = renderToolInventory([tool], "claude-3-5-sonnet-20241022");
		expect(out).toContain("Parameters: {");
		expect(out).not.toContain("<examples>");
	});

	it("returns an empty string when there are no tools", () => {
		expect(renderToolInventory([], "claude-3-5-sonnet-20241022")).toBe("");
	});
});
