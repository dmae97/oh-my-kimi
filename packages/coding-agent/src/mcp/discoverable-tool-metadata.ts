/**
 * Back-compat re-export layer.
 * All types and functions have moved to src/tool-discovery/tool-index.ts.
 * This file exists solely so existing imports continue to compile without changes.
 */
export type {
	DiscoverableMCPSearchDocument,
	DiscoverableMCPSearchIndex,
	DiscoverableMCPSearchResult,
	DiscoverableMCPTool,
	DiscoverableMCPToolServerSummary,
	DiscoverableMCPToolSummary,
} from "../tool-discovery/tool-index";

export {
	buildDiscoverableMCPSearchIndex,
	collectDiscoverableMCPTools,
	formatDiscoverableMCPToolServerSummary,
	getDiscoverableMCPTool,
	isMCPToolName,
	searchDiscoverableMCPTools,
	selectDiscoverableMCPToolNamesByServer,
	summarizeDiscoverableMCPTools,
} from "../tool-discovery/tool-index";
