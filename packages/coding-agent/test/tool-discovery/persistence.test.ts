import { describe, expect, it } from "bun:test";
import type { DiscoverableTool } from "../../src/tool-discovery/tool-index";
import { buildDiscoverableMCPSearchIndex, buildDiscoverableToolSearchIndex } from "../../src/tool-discovery/tool-index";

// ─── Tests that verify the generic discovery index is compatible with
//     legacy MCP-format data (legacy persistence / back-compat).
// ─────────────────────────────────────────────────────────────────────────────

describe("persistence back-compat: buildDiscoverableMCPSearchIndex wraps generic index", () => {
	const legacyMCPTools = [
		{
			name: "mcp__github_create_issue",
			label: "github/create_issue",
			description: "Create a GitHub issue",
			serverName: "github",
			mcpToolName: "create_issue",
			schemaKeys: ["owner", "repo", "title"],
		},
		{
			name: "mcp__slack_post",
			label: "slack/post_message",
			description: "Post a Slack message",
			serverName: "slack",
			mcpToolName: "post_message",
			schemaKeys: ["channel", "text"],
		},
	];

	it("returns correct document count", () => {
		const index = buildDiscoverableMCPSearchIndex(legacyMCPTools);
		expect(index.documents).toHaveLength(2);
	});

	it("maps description → summary in the index", () => {
		const index = buildDiscoverableMCPSearchIndex(legacyMCPTools);
		// The documents contain DiscoverableTool objects with .summary, not .description
		const doc = index.documents.find(d => d.tool.name === "mcp__github_create_issue");
		expect(doc).toBeDefined();
		// summary was set from description
		expect(doc!.tool.summary).toBe("Create a GitHub issue");
	});

	it("is searchable with standard search function", () => {
		const { searchDiscoverableTools } = require("../../src/tool-discovery/tool-index");
		const index = buildDiscoverableMCPSearchIndex(legacyMCPTools);
		const results = searchDiscoverableTools(index, "github issue", 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.tool.name).toBe("mcp__github_create_issue");
	});
});

describe("generic index: DiscoverableTool round-trip", () => {
	const tools: DiscoverableTool[] = [
		{
			name: "find",
			label: "find",
			summary: "Find files matching a glob pattern",
			source: "builtin",
			schemaKeys: ["pattern", "path"],
		},
		{
			name: "mcp__gh_search",
			label: "github/search",
			summary: "Search GitHub repositories",
			source: "mcp",
			serverName: "github",
			mcpToolName: "search",
			schemaKeys: ["query"],
		},
	];

	it("builds and searches without loss", () => {
		const { searchDiscoverableTools } = require("../../src/tool-discovery/tool-index");
		const index = buildDiscoverableToolSearchIndex(tools);
		expect(index.documents).toHaveLength(2);

		const findResults = searchDiscoverableTools(index, "find files", 3);
		expect(findResults.some((r: any) => r.tool.name === "find")).toBe(true);

		const ghResults = searchDiscoverableTools(index, "github search", 3);
		expect(ghResults.some((r: any) => r.tool.name === "mcp__gh_search")).toBe(true);
	});

	it("preserves source field in search results", () => {
		const { searchDiscoverableTools } = require("../../src/tool-discovery/tool-index");
		const index = buildDiscoverableToolSearchIndex(tools);
		const results = searchDiscoverableTools(index, "github", 3);
		const ghResult = results.find((r: any) => r.tool.name === "mcp__gh_search");
		expect(ghResult).toBeDefined();
		expect(ghResult!.tool.source).toBe("mcp");
	});
});
