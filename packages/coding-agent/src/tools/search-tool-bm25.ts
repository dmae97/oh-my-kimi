import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import {
	buildDiscoverableMCPSearchIndex,
	type DiscoverableMCPSearchIndex,
	type DiscoverableMCPTool,
	formatDiscoverableMCPToolServerSummary,
	searchDiscoverableMCPTools,
	summarizeDiscoverableMCPTools,
} from "../mcp/discoverable-tool-metadata";
import type { Theme } from "../modes/theme/theme";
import searchToolBm25Description from "../prompts/tools/search-tool-bm25.md" with { type: "text" };
import { renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_LIMIT = 8;
const TOOL_DISCOVERY_TITLE = "Tool Discovery";
const COLLAPSED_MATCH_LIMIT = 5;
const MATCH_LABEL_LEN = 72;
const MATCH_DESCRIPTION_LEN = 96;

const searchToolBm25Schema = Type.Object({
	query: Type.String({ description: "mcp search query", examples: ["kubernetes pod", "image processing"] }),
	limit: Type.Optional(Type.Integer({ description: "max matches", minimum: 1 })),
});

type SearchToolBm25Params = Static<typeof searchToolBm25Schema>;

interface SearchToolBm25Match {
	name: string;
	label: string;
	description: string;
	server_name?: string;
	mcp_tool_name?: string;
	schema_keys: string[];
	score: number;
}

export interface SearchToolBm25Details {
	query: string;
	limit: number;
	total_tools: number;
	activated_tools: string[];
	active_selected_tools: string[];
	tools: SearchToolBm25Match[];
}

function formatMatch(tool: DiscoverableMCPTool, score: number): SearchToolBm25Match {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		server_name: tool.serverName,
		mcp_tool_name: tool.mcpToolName,
		schema_keys: tool.schemaKeys,
		score: Number(score.toFixed(6)),
	};
}

function buildSearchToolBm25Content(details: SearchToolBm25Details): string {
	return JSON.stringify({
		query: details.query,
		activated_tools: details.activated_tools,
		match_count: details.tools.length,
		total_tools: details.total_tools,
	});
}

function getDiscoverableMCPToolsForDescription(session: ToolSession): DiscoverableMCPTool[] {
	try {
		return session.getDiscoverableMCPTools?.() ?? [];
	} catch {
		return [];
	}
}

function getDiscoverableMCPSearchIndexForExecution(session: ToolSession): DiscoverableMCPSearchIndex {
	try {
		const cached = session.getDiscoverableMCPSearchIndex?.();
		if (cached) return cached;
	} catch {}
	return buildDiscoverableMCPSearchIndex(session.getDiscoverableMCPTools?.() ?? []);
}

type MCPDiscoveryExecutionSession = ToolSession & {
	isMCPDiscoveryEnabled: () => boolean;
	getSelectedMCPToolNames: () => string[];
	activateDiscoveredMCPTools: (toolNames: string[]) => Promise<string[]>;
};

function supportsMCPToolDiscoveryExecution(session: ToolSession): session is MCPDiscoveryExecutionSession {
	return (
		typeof session.isMCPDiscoveryEnabled === "function" &&
		typeof session.getSelectedMCPToolNames === "function" &&
		typeof session.activateDiscoveredMCPTools === "function"
	);
}

export function renderSearchToolBm25Description(discoverableTools: DiscoverableMCPTool[] = []): string {
	const summary = summarizeDiscoverableMCPTools(discoverableTools);
	return prompt.render(searchToolBm25Description, {
		discoverableMCPToolCount: summary.toolCount,
		discoverableMCPServerSummaries: summary.servers.map(formatDiscoverableMCPToolServerSummary),
		hasDiscoverableMCPServers: summary.servers.length > 0,
	});
}

function renderMatchLines(match: SearchToolBm25Match, theme: Theme): string[] {
	const safeServerName = match.server_name ? replaceTabs(match.server_name) : undefined;
	const safeLabel = replaceTabs(match.label);
	const safeDescription = replaceTabs(match.description.trim());
	const metaParts: string[] = [];
	if (safeServerName) metaParts.push(theme.fg("muted", safeServerName));
	metaParts.push(theme.fg("dim", `score ${match.score.toFixed(3)}`));
	const metaSep = theme.fg("dim", theme.sep.dot);
	const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
	const lines = [`${theme.fg("accent", truncateToWidth(safeLabel, MATCH_LABEL_LEN))}${metaSuffix}`];
	if (safeDescription) {
		lines.push(theme.fg("muted", truncateToWidth(safeDescription, MATCH_DESCRIPTION_LEN)));
	}
	return lines;
}

function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: TOOL_DISCOVERY_TITLE }, theme);
	const bodyLines = (text || "Tool discovery completed")
		.split("\n")
		.map(line => theme.fg("dim", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}

export class SearchToolBm25Tool implements AgentTool<typeof searchToolBm25Schema, SearchToolBm25Details> {
	readonly name = "search_tool_bm25";
	readonly label = "SearchToolBm25";
	get description(): string {
		return renderSearchToolBm25Description(getDiscoverableMCPToolsForDescription(this.session));
	}
	readonly parameters = searchToolBm25Schema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SearchToolBm25Tool | null {
		if (!session.settings.get("mcp.discoveryMode")) return null;
		return supportsMCPToolDiscoveryExecution(session) ? new SearchToolBm25Tool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolBm25Params,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolBm25Details>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolBm25Details>> {
		if (!supportsMCPToolDiscoveryExecution(this.session)) {
			throw new ToolError("MCP tool discovery is unavailable in this session.");
		}
		if (!this.session.isMCPDiscoveryEnabled()) {
			throw new ToolError("MCP tool discovery is disabled. Enable mcp.discoveryMode to use search_tool_bm25.");
		}

		const query = params.query.trim();
		if (query.length === 0) {
			throw new ToolError("Query is required and must not be empty.");
		}
		const limit = params.limit ?? DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new ToolError("Limit must be a positive integer.");
		}

		const searchIndex = getDiscoverableMCPSearchIndexForExecution(this.session);
		const selectedToolNames = new Set(this.session.getSelectedMCPToolNames());
		let ranked: Array<{ tool: DiscoverableMCPTool; score: number }> = [];
		try {
			ranked = searchDiscoverableMCPTools(searchIndex, query, searchIndex.documents.length)
				.filter(result => !selectedToolNames.has(result.tool.name))
				.slice(0, limit);
		} catch (error) {
			if (error instanceof Error) {
				throw new ToolError(error.message);
			}
			throw error;
		}
		const activated =
			ranked.length > 0 ? await this.session.activateDiscoveredMCPTools(ranked.map(result => result.tool.name)) : [];

		const details: SearchToolBm25Details = {
			query,
			limit,
			total_tools: searchIndex.documents.length,
			activated_tools: activated,
			active_selected_tools: this.session.getSelectedMCPToolNames(),
			tools: ranked.map(result => formatMatch(result.tool, result.score)),
		};

		return {
			content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
			details,
		};
	}
}

export const searchToolBm25Renderer = {
	renderCall(args: SearchToolBm25Params, _options: RenderResultOptions, uiTheme: Theme): Component {
		const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
		const meta = args.limit ? [`limit:${args.limit}`] : [];
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: TOOL_DISCOVERY_TITLE, description: query || "(empty query)", meta },
				uiTheme,
			),
			0,
			0,
		);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolBm25Details; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (!result.details) {
			const fallbackText = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.filter((text): text is string => typeof text === "string" && text.length > 0)
				.join("\n");
			return renderFallbackResult(fallbackText, uiTheme);
		}

		const { details } = result;
		const meta = [
			formatCount("match", details.tools.length),
			`${details.active_selected_tools.length} active`,
			`${details.total_tools} total`,
			`limit:${details.limit}`,
		];
		const safeQuery = replaceTabs(details.query);
		const header = renderStatusLine(
			{
				icon: details.tools.length > 0 ? "success" : "warning",
				title: TOOL_DISCOVERY_TITLE,
				description: truncateToWidth(safeQuery, MATCH_LABEL_LEN),
				meta,
			},
			uiTheme,
		);
		if (details.tools.length === 0) {
			const emptyMessage =
				details.total_tools === 0 ? "No discoverable MCP tools are currently loaded." : "No matching tools found.";
			return new Text(`${header}\n${uiTheme.fg("muted", emptyMessage)}`, 0, 0);
		}

		const lines = [header];
		const treeLines = renderTreeList(
			{
				items: details.tools,
				expanded: options.expanded,
				maxCollapsed: COLLAPSED_MATCH_LIMIT,
				itemType: "tool",
				renderItem: match => renderMatchLines(match, uiTheme),
			},
			uiTheme,
		);
		lines.push(...treeLines);
		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
	inline: true,
};
