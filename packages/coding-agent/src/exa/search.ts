/**
 * Exa Search Tools
 *
 * Basic neural/keyword search, deep research, code search, and URL crawling.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import * as z from "zod/v4";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { createExaTool } from "./factory";
import type { ExaRenderDetails } from "./types";

/** exa_search - Basic neural/keyword search */
const exaSearchTool = createExaTool(
	"exa_search",
	"Exa Search",
	`Search the web using Exa's neural or keyword search.

Returns structured search results with optional text content and highlights.

Parameters:
- query: Search query (required)
- type: Search type - "neural" (semantic), "keyword" (exact), or "auto" (default: auto)
- include_domains: Array of domains to include in results
- exclude_domains: Array of domains to exclude from results
- start_published_date: Filter results published after this date (ISO 8601)
- end_published_date: Filter results published before this date (ISO 8601)
- use_autoprompt: Let Exa optimize your query automatically (default: true)
- text: Include page text content in results (default: false, costs more)
- highlights: Include highlighted relevant snippets (default: false)
- num_results: Maximum number of results to return (default: 10, max: 100)`,

	z.object({
		query: z.string().describe("Search query"),
		type: z
			.enum(["keyword", "neural", "auto"])
			.describe("Search type - neural (semantic), keyword (exact), or auto")
			.optional(),
		include_domains: z.array(z.string()).describe("Only include results from these domains").optional(),
		exclude_domains: z.array(z.string()).describe("Exclude results from these domains").optional(),
		start_published_date: z
			.string()
			.describe("Filter results published after this date (ISO 8601 format)")
			.optional(),
		end_published_date: z.string().describe("Filter results published before this date (ISO 8601 format)").optional(),
		use_autoprompt: z.boolean().describe("Let Exa optimize your query automatically (default: true)").optional(),
		text: z.boolean().describe("Include page text content in results (costs more, default: false)").optional(),
		highlights: z.boolean().describe("Include highlighted relevant snippets (default: false)").optional(),
		num_results: z
			.number()
			.int()
			.min(1)
			.max(100)
			.describe("Maximum number of results to return (default: 10, max: 100)")
			.optional(),
	}),
	"web_search_exa",
);

export const searchTools: CustomTool<TSchema, ExaRenderDetails>[] = [exaSearchTool];
