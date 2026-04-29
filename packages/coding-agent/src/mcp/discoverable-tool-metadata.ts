import type { AgentTool } from "@oh-my-pi/pi-agent-core";

export interface DiscoverableMCPTool {
	name: string;
	label: string;
	description: string;
	serverName?: string;
	mcpToolName?: string;
	schemaKeys: string[];
}

export interface DiscoverableMCPToolServerSummary {
	name: string;
	toolCount: number;
}

export interface DiscoverableMCPToolSummary {
	servers: DiscoverableMCPToolServerSummary[];
	toolCount: number;
}

export function formatDiscoverableMCPToolServerSummary(server: DiscoverableMCPToolServerSummary): string {
	const toolLabel = server.toolCount === 1 ? "tool" : "tools";
	return `${server.name} (${server.toolCount} ${toolLabel})`;
}

export interface DiscoverableMCPSearchDocument {
	tool: DiscoverableMCPTool;
	termFrequencies: Map<string, number>;
	length: number;
}

export interface DiscoverableMCPSearchIndex {
	documents: DiscoverableMCPSearchDocument[];
	averageLength: number;
	documentFrequencies: Map<string, number>;
}

export interface DiscoverableMCPSearchResult {
	tool: DiscoverableMCPTool;
	score: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FIELD_WEIGHTS = {
	name: 6,
	label: 4,
	serverName: 2,
	mcpToolName: 4,
	description: 2,
	schemaKey: 1,
} as const;

export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

function getSchemaPropertyKeys(parameters: unknown): string[] {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
	const properties = (parameters as { properties?: unknown }).properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
	return Object.keys(properties as Record<string, unknown>).sort();
}

function tokenize(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string | undefined, weight: number): void {
	if (!value) return;
	for (const token of tokenize(value)) {
		termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
	}
}

function buildSearchDocument(tool: DiscoverableMCPTool): DiscoverableMCPSearchDocument {
	const termFrequencies = new Map<string, number>();
	addWeightedTokens(termFrequencies, tool.name, FIELD_WEIGHTS.name);
	addWeightedTokens(termFrequencies, tool.label, FIELD_WEIGHTS.label);
	addWeightedTokens(termFrequencies, tool.serverName, FIELD_WEIGHTS.serverName);
	addWeightedTokens(termFrequencies, tool.mcpToolName, FIELD_WEIGHTS.mcpToolName);
	addWeightedTokens(termFrequencies, tool.description, FIELD_WEIGHTS.description);
	for (const schemaKey of tool.schemaKeys) {
		addWeightedTokens(termFrequencies, schemaKey, FIELD_WEIGHTS.schemaKey);
	}
	const length = Array.from(termFrequencies.values()).reduce((sum, value) => sum + value, 0);
	return { tool, termFrequencies, length };
}

export function getDiscoverableMCPTool(tool: AgentTool): DiscoverableMCPTool | null {
	if (!isMCPToolName(tool.name)) return null;
	const toolRecord = tool as AgentTool & {
		label?: string;
		description?: string;
		mcpServerName?: string;
		mcpToolName?: string;
		parameters?: unknown;
	};
	return {
		name: tool.name,
		label: typeof toolRecord.label === "string" ? toolRecord.label : tool.name,
		description: typeof toolRecord.description === "string" ? toolRecord.description : "",
		serverName: typeof toolRecord.mcpServerName === "string" ? toolRecord.mcpServerName : undefined,
		mcpToolName: typeof toolRecord.mcpToolName === "string" ? toolRecord.mcpToolName : undefined,
		schemaKeys: getSchemaPropertyKeys(toolRecord.parameters),
	};
}

export function collectDiscoverableMCPTools(tools: Iterable<AgentTool>): DiscoverableMCPTool[] {
	const discoverable: DiscoverableMCPTool[] = [];
	for (const tool of tools) {
		const metadata = getDiscoverableMCPTool(tool);
		if (metadata) {
			discoverable.push(metadata);
		}
	}
	return discoverable;
}

export function selectDiscoverableMCPToolNamesByServer(
	tools: Iterable<DiscoverableMCPTool>,
	serverNames: ReadonlySet<string>,
): string[] {
	if (serverNames.size === 0) return [];
	return Array.from(tools)
		.filter(tool => tool.serverName !== undefined && serverNames.has(tool.serverName))
		.map(tool => tool.name);
}

export function summarizeDiscoverableMCPTools(tools: DiscoverableMCPTool[]): DiscoverableMCPToolSummary {
	const serverToolCounts = new Map<string, number>();
	for (const tool of tools) {
		if (!tool.serverName) continue;
		serverToolCounts.set(tool.serverName, (serverToolCounts.get(tool.serverName) ?? 0) + 1);
	}
	const servers = Array.from(serverToolCounts.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, toolCount]) => ({ name, toolCount }));
	return {
		servers,
		toolCount: tools.length,
	};
}

export function buildDiscoverableMCPSearchIndex(tools: Iterable<DiscoverableMCPTool>): DiscoverableMCPSearchIndex {
	const documents = Array.from(tools, buildSearchDocument);
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const documentFrequencies = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set(document.termFrequencies.keys())) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
		}
	}
	return {
		documents,
		averageLength,
		documentFrequencies,
	};
}

export function searchDiscoverableMCPTools(
	index: DiscoverableMCPSearchIndex,
	query: string,
	limit: number,
): DiscoverableMCPSearchResult[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) {
		throw new Error("Query must contain at least one letter or number.");
	}
	if (index.documents.length === 0) {
		return [];
	}

	const queryTermCounts = new Map<string, number>();
	for (const token of queryTokens) {
		queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
	}

	return index.documents
		.map(document => {
			let score = 0;
			for (const [token, queryTermCount] of queryTermCounts) {
				const termFrequency = document.termFrequencies.get(token) ?? 0;
				if (termFrequency === 0) continue;
				const documentFrequency = index.documentFrequencies.get(token) ?? 0;
				const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
				const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
				score += queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization));
			}
			return { tool: document.tool, score };
		})
		.filter(result => result.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, limit);
}
