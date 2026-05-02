import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Settings } from "../../src/config/settings";
// Back-compat import check — these re-exports from mcp/discoverable-tool-metadata should still work
import { buildDiscoverableMCPSearchIndex, type DiscoverableMCPTool } from "../../src/mcp/discoverable-tool-metadata";
import type { DiscoverableMCPSearchIndex, DiscoverableTool } from "../../src/tool-discovery/tool-index";
import type { ToolSession } from "../../src/tools/index";
import {
	renderSearchToolBm25Description,
	SearchToolBm25Tool,
	searchToolBm25Renderer,
} from "../../src/tools/search-tool-bm25";

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

	it("advertises discoverable MCP servers and search guidance in its description", () => {
		const description = renderSearchToolBm25Description(discoverableTools);
		expect(description).toContain("Discoverable MCP servers in this session: github (2 tools), slack (1 tool).");
		expect(description).not.toContain("Example discoverable MCP tools:");
		expect(description).toContain("Total discoverable tools available: 3.");
		expect(description).toContain("If you are unsure, start with `limit` between 5 and 10");
		expect(description).toContain("- `label`");
		expect(description).toContain("- `mcp_tool_name`");
		expect(description).toContain("input schema property keys (`schema_keys`)");
		expect(description).toContain("- `activated_tools` — tools activated by this search call");
		expect(description).toContain("- `match_count` — number of ranked matches returned by the search");
		expect(description).not.toContain("- `active_selected_tools`");
		expect(description).not.toContain("- `tools`");
	});

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

	it("renders a titled discovery summary instead of the raw tool name", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderedCall = searchToolBm25Renderer.renderCall(
			{ query: "github issue", limit: 2 },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		expect(renderedCall.render(120).join("\n")).toContain("Tool Discovery");
		expect(renderedCall.render(120).join("\n")).not.toContain("search_tool_bm25");

		const renderedResult = searchToolBm25Renderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					query: "github issue",
					limit: 2,
					total_tools: 3,
					activated_tools: ["mcp__github_create_issue"],
					active_selected_tools: ["mcp__github_create_issue"],
					tools: [
						{
							name: "mcp__github_create_issue",
							label: "github/create_issue",
							description: "Create a GitHub issue in the selected repository",
							server_name: "github",
							mcp_tool_name: "create_issue",
							schema_keys: ["owner", "repo", "title", "body"],
							score: 1.234567,
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const renderedText = renderedResult.render(120).join("\n");
		expect(renderedText).toContain("Tool Discovery");
		expect(renderedText).toContain("github/create_issue");
		expect(renderedText).toContain("1 active");
		expect(renderedText).toContain("limit:2");
		expect(renderedText).not.toContain("keys:");
		expect(renderedText).not.toContain("search_tool_bm25");
	});

	it("truncates fallback discovery text before rendering", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const longLine = "Long discovery output ".repeat(20);
		const renderedResult = searchToolBm25Renderer.renderResult(
			{
				content: [{ type: "text", text: longLine }],
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const renderedText = renderedResult.render(200).join("\n");
		expect(renderedText).toContain("Tool Discovery");
		expect(renderedText).toContain("Long discovery output Long discovery output");
		expect(renderedText).not.toContain(longLine);
	});

	it("tolerates partially streamed render-call arguments", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderedCall = searchToolBm25Renderer.renderCall(
			{} as never,
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(renderedCall.render(120).join("\n")).toContain("(empty query)");
	});

	it("sanitizes MCP metadata before rendering discovery output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderedResult = searchToolBm25Renderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					query: "github\tissue",
					limit: 2,
					total_tools: 1,
					activated_tools: ["mcp__github_create_issue"],
					active_selected_tools: ["mcp__github_create_issue"],
					tools: [
						{
							name: "mcp__github_create_issue",
							label: "github\t/create_issue",
							description: "Create\ta GitHub issue",
							server_name: "git\thub",
							mcp_tool_name: "create_issue",
							schema_keys: ["owner", "repo"],
							score: 1.234567,
						},
					],
				},
			},
			{ expanded: true, isPartial: false },
			uiTheme,
		);
		const renderedText = renderedResult.render(120).join("\n");
		expect(renderedText).not.toContain("\t");
		expect(renderedText).toContain("github   issue");
		expect(renderedText).toContain("git   hub");
		expect(renderedText).toContain("Create   a GitHub issue");
	});

	it("shows at most five tools in collapsed renderer output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const tools = Array.from({ length: 6 }, (_, index) => ({
			name: `mcp__github_tool_${index + 1}`,
			label: `github/tool_${index + 1}`,
			description: `GitHub tool ${index + 1}`,
			server_name: "github",
			mcp_tool_name: `tool_${index + 1}`,
			schema_keys: ["owner", "repo"],
			score: 1 - index * 0.01,
		}));
		const rendered = searchToolBm25Renderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					query: "github tools",
					limit: 8,
					total_tools: 6,
					activated_tools: tools.map(tool => tool.name),
					active_selected_tools: tools.map(tool => tool.name),
					tools,
				},
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const renderedText = rendered.render(120).join("\n");
		expect(renderedText).toContain("github/tool_5");
		expect(renderedText).not.toContain("github/tool_6");
		expect(renderedText).toContain("1 more tool");
	});

	it("defaults to 8 results and lets callers override the limit", async () => {
		const manyTools: DiscoverableTool[] = Array.from({ length: 10 }, (_, index) =>
			mcpTool(
				`mcp__github_tool_${index + 1}`,
				"github",
				`tool_${index + 1}`,
				`GitHub tool ${index + 1} for repository workflows`,
				["owner", "repo", `field_${index + 1}`],
			),
		);
		const tool = new SearchToolBm25Tool(createSession(manyTools));

		const defaultResult = await tool.execute("call-default", { query: "github" });
		expect(defaultResult.details?.limit).toBe(8);
		expect(defaultResult.details?.tools).toHaveLength(8);
		expect(defaultResult.details?.active_selected_tools).toHaveLength(8);
		const defaultContent = defaultResult.content[0];
		expect(defaultContent).toBeDefined();
		expect(defaultContent).toEqual({
			type: "text",
			text: JSON.stringify({
				query: "github",
				activated_tools: defaultResult.details?.activated_tools,
				match_count: 8,
				total_tools: 10,
			}),
		});

		const limitedTool = new SearchToolBm25Tool(createSession(manyTools));
		const limitedResult = await limitedTool.execute("call-limited", { query: "github", limit: 3 });
		expect(limitedResult.details?.limit).toBe(3);
		expect(limitedResult.details?.tools).toHaveLength(3);
		expect(limitedResult.details?.active_selected_tools).toHaveLength(3);
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
