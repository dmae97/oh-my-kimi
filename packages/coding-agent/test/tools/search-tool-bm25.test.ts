import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
// Back-compat import check — these re-exports from mcp/discoverable-tool-metadata should still work
import { buildDiscoverableMCPSearchIndex, type DiscoverableMCPTool } from "../../src/mcp/discoverable-tool-metadata";
import type { DiscoverableMCPSearchIndex, DiscoverableTool } from "../../src/tool-discovery/tool-index";
import type { ToolSession } from "../../src/tools/index";
import { SearchToolBm25Tool } from "../../src/tools/search-tool-bm25";

type TestDiscoverableTool = DiscoverableTool;

/** Adapt a generic discoverable tool to the legacy MCP shape (with `description`). */
function toLegacyMCP(t: DiscoverableTool): DiscoverableMCPTool {
	return {
		name: t.name,
		label: t.label,
		description: t.summary,
		serverName: t.serverName,
		mcpToolName: t.mcpToolName,
		schemaKeys: t.schemaKeys,
	};
}

type DiscoveryToolSession = ToolSession & {
	isMCPDiscoveryEnabled: () => boolean;
	getDiscoverableMCPTools: () => DiscoverableMCPTool[];
	getDiscoverableMCPSearchIndex?: () => DiscoverableMCPSearchIndex;
	getSelectedMCPToolNames: () => string[];
	activateDiscoveredMCPTools: (toolNames: string[]) => Promise<string[]>;
	getSelected: () => string[];
};

function createSession(
	tools: TestDiscoverableTool[],
	overrides: Partial<DiscoveryToolSession> = {},
): DiscoveryToolSession {
	const selected: string[] = [];
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "mcp.discoveryMode": true }),
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableMCPTools: () => tools.map(toLegacyMCP),
		getSelectedMCPToolNames: () => [...selected],
		activateDiscoveredMCPTools: async (toolNames: string[]) => {
			for (const name of toolNames) {
				if (!selected.includes(name)) {
					selected.push(name);
				}
			}
			return toolNames;
		},
		getSelected: () => [...selected],
		...overrides,
	};
}

/** Helper to create a discoverable MCP tool (new unified shape) */
function mcpTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	summary: string,
	schemaKeys: string[],
): DiscoverableTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		summary,
		source: "mcp",
		serverName,
		mcpToolName,
		schemaKeys,
	};
}

/** Helper to create a discoverable built-in tool (new unified shape) */
function builtinTool(name: string, summary: string, schemaKeys: string[] = []): DiscoverableTool {
	return {
		name,
		label: name,
		summary,
		source: "builtin",
		schemaKeys,
	};
}

describe("SearchToolBm25Tool", () => {
	const discoverableTools: DiscoverableTool[] = [
		mcpTool(
			"mcp__github_create_issue",
			"github",
			"create_issue",
			"Create a GitHub issue in the selected repository",
			["owner", "repo", "title", "body"],
		),
		mcpTool("mcp__github_list_pull_requests", "github", "list_pull_requests", "List pull requests for a repository", [
			"owner",
			"repo",
			"state",
		]),
		mcpTool("mcp__slack_post_message", "slack", "post_message", "Post a message to a Slack channel", [
			"channel",
			"text",
		]),
	];

	it("uses the session-provided cached search index during execution", async () => {
		let rawToolsCalls = 0;
		let searchIndexCalls = 0;
		// Build via the legacy helper so documents expose `tool.description` (the legacy shape).
		const searchIndex = buildDiscoverableMCPSearchIndex(discoverableTools.map(toLegacyMCP));
		const session = createSession(discoverableTools, {
			getDiscoverableMCPTools: () => {
				rawToolsCalls++;
				return discoverableTools.map(toLegacyMCP);
			},
			getDiscoverableMCPSearchIndex: () => {
				searchIndexCalls++;
				return searchIndex;
			},
		});
		const tool = new SearchToolBm25Tool(session);
		expect(rawToolsCalls).toBe(0);

		const result = await tool.execute("call-index", { query: "github" });
		expect(searchIndexCalls).toBe(1);
		expect(rawToolsCalls).toBe(0);
		expect(result.details?.tools.map(match => match.name)).toEqual([
			"mcp__github_create_issue",
			"mcp__github_list_pull_requests",
		]);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					query: "github",
					activated_tools: ["mcp__github_create_issue", "mcp__github_list_pull_requests"],
					match_count: 2,
					total_tools: 3,
				}),
			},
		]);
	});

	it("returns ranked matches and unions activated tools across repeated searches", async () => {
		const session = createSession(discoverableTools);
		const tool = new SearchToolBm25Tool(session);

		const firstResult = await tool.execute("call-1", { query: "github issue", limit: 1 });
		const firstDetails = firstResult.details;
		expect(firstDetails?.tools.map(match => match.name)).toEqual(["mcp__github_create_issue"]);
		expect(firstDetails?.active_selected_tools).toEqual(["mcp__github_create_issue"]);
		expect(session.getSelected()).toEqual(["mcp__github_create_issue"]);

		const secondResult = await tool.execute("call-2", { query: "slack message", limit: 1 });
		const secondDetails = secondResult.details;
		expect(secondDetails?.tools.map(match => match.name)).toEqual(["mcp__slack_post_message"]);
		expect(secondDetails?.active_selected_tools).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
		expect(session.getSelected()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
	});

	it("skips already-selected matches before applying limit", async () => {
		const session = createSession(discoverableTools);
		const tool = new SearchToolBm25Tool(session);

		const firstResult = await tool.execute("call-github-1", { query: "github", limit: 1 });
		expect(firstResult.details?.tools.map(match => match.name)).toEqual(["mcp__github_create_issue"]);
		expect(firstResult.details?.activated_tools).toEqual(["mcp__github_create_issue"]);

		const secondResult = await tool.execute("call-github-2", { query: "github", limit: 1 });
		expect(secondResult.details?.tools.map(match => match.name)).toEqual(["mcp__github_list_pull_requests"]);
		expect(secondResult.details?.activated_tools).toEqual(["mcp__github_list_pull_requests"]);
		expect(secondResult.details?.active_selected_tools).toEqual([
			"mcp__github_create_issue",
			"mcp__github_list_pull_requests",
		]);

		const exhaustedResult = await tool.execute("call-github-3", { query: "github", limit: 1 });
		expect(exhaustedResult.details?.tools).toEqual([]);
		expect(exhaustedResult.details?.activated_tools).toEqual([]);
		expect(exhaustedResult.details?.active_selected_tools).toEqual([
			"mcp__github_create_issue",
			"mcp__github_list_pull_requests",
		]);
	});

	it("rejects invalid input", async () => {
		const tool = new SearchToolBm25Tool(createSession(discoverableTools));

		await expect(tool.execute("call-empty", { query: "   " })).rejects.toThrow(
			"Query is required and must not be empty.",
		);
		await expect(tool.execute("call-limit", { query: "github", limit: 0 as never })).rejects.toThrow(
			"Limit must be a positive integer.",
		);
	});

	it("rejects execution when discovery mode is disabled", async () => {
		const tool = new SearchToolBm25Tool(
			createSession(discoverableTools, {
				isMCPDiscoveryEnabled: () => false,
				settings: Settings.isolated({ "mcp.discoveryMode": false }),
			}),
		);

		await expect(tool.execute("call-disabled", { query: "github" })).rejects.toThrow("Tool discovery is disabled.");
	});

	it("discovers built-in tools when using the new tools.discoveryMode=all setting", async () => {
		const builtinTools: DiscoverableTool[] = [
			builtinTool("find", "Find files and directories matching a glob pattern"),
			builtinTool("search", "Search file contents using ripgrep"),
		];
		const allTools = [...discoverableTools, ...builtinTools];
		const session = createSession(discoverableTools, {
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			// Override to provide all tools including built-ins (legacy MCP shape).
			getDiscoverableMCPTools: () => allTools.map(toLegacyMCP),
		});
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-builtin", { query: "find files" });
		// Should find built-in 'find' tool
		const names = result.details?.tools.map(t => t.name) ?? [];
		expect(names).toContain("find");
	});

	it("back-compat: buildDiscoverableMCPSearchIndex still works via mcp/discoverable-tool-metadata", () => {
		// This test ensures the legacy MCP module re-exports still function correctly
		const index = buildDiscoverableMCPSearchIndex([
			{
				name: "mcp__test",
				label: "test/tool",
				description: "A test MCP tool",
				serverName: "test",
				mcpToolName: "tool",
				schemaKeys: ["query"],
			},
		]);
		expect(index.documents).toHaveLength(1);
		expect(index.documents[0]?.tool.name).toBe("mcp__test");
	});
});
