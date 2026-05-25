/**
 * Kagi Web Search Provider
 *
 * Thin wrapper that adapts shared Kagi API utilities to SearchResponse shape.
 */
import type { AgentStorage } from "../../../session/agent-storage";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { findKagiApiKey, KagiApiError, searchWithKagi } from "../../kagi";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, toSearchSources } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

/** Execute Kagi web search. */
export async function searchKagi(
	params: {
		query: string;
		num_results?: number;
		signal?: AbortSignal;
	},
	storage: AgentStorage,
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	try {
		const result = await searchWithKagi(
			params.query,
			{
				limit: numResults,
				signal: params.signal,
			},
			storage,
		);

		return {
			provider: "kagi",
			sources: toSearchSources(result.sources, numResults),
			relatedQuestions: result.relatedQuestions.length > 0 ? result.relatedQuestions : undefined,
			requestId: result.requestId,
		};
	} catch (err) {
		if (err instanceof KagiApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("kagi", err.statusCode, err.message);
				if (classified) throw classified;
			}
			throw new SearchProviderError("kagi", err.message, err.statusCode);
		}
		throw err;
	}
}

/** Search provider for Kagi web search. */
export class KagiProvider extends SearchProvider {
	readonly id = "kagi";
	readonly label = "Kagi";

	async isAvailable(storage: AgentStorage) {
		try {
			return !!findKagiApiKey(storage);
		} catch {
			return false;
		}
	}

	search(params: SearchParams, storage: AgentStorage): Promise<SearchResponse> {
		return searchKagi(
			{
				query: params.query,
				num_results: params.numSearchResults ?? params.limit,
				signal: params.signal,
			},
			storage,
		);
	}
}
