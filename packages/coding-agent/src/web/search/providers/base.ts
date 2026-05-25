import type { AgentStorage } from "../../../session/agent-storage";
import type { SearchProviderId, SearchResponse } from "../types";

/** Shared web search parameters passed to providers. */
export interface SearchParams {
	query: string;
	limit?: number;
	/**
	 * Temporal filter narrowing results to the specified time window.
	 *
	 * Providers MUST interpret this as a pure time filter. Providers MUST NOT
	 * use recency as an implicit signal to change topic scope, content domain,
	 * or ranking strategy. If a provider API couples temporal filtering with
	 * other dimensions (e.g. Tavily's `topic=news`), the provider implementation
	 * is responsible for decoupling them before calling the upstream API.
	 *
	 * Providers that do not support temporal filtering MUST ignore this field
	 * silently; they MUST NOT approximate it by rewriting the query or altering
	 * any other request parameter.
	 */
	recency?: "day" | "week" | "month" | "year";
	systemPrompt: string;
	signal?: AbortSignal;
	maxOutputTokens?: number;
	numSearchResults?: number;
	temperature?: number;
	googleSearch?: Record<string, unknown>;
	codeExecution?: Record<string, unknown>;
	urlContext?: Record<string, unknown>;
}

/** Base class for web search providers. */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/**
	 * Indicates whether this provider has the credentials/config it needs to
	 * service a request right now. Implementations may consult the shared
	 * {@link AgentStorage} handle for stored OAuth credentials and avoid
	 * opening their own connection.
	 */
	abstract isAvailable(storage: AgentStorage): Promise<boolean> | boolean;

	/**
	 * Execute a search. Implementations that read credentials from
	 * {@link AgentStorage} MUST use the passed handle instead of opening a
	 * second one.
	 */
	abstract search(params: SearchParams, storage: AgentStorage): Promise<SearchResponse>;
}
