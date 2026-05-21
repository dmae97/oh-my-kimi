/**
 * Kagi V1 Web Search Provider
 *
 * Thin wrapper that adapts shared Kagi V1 API utilities to SearchResponse shape.
 */
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { findKagiApiKey, KagiV1ApiError, searchWithKagiV1 } from "../../kagi-v1";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { toSearchSources } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

/** Execute Kagi V1 web search. */
export async function searchKagiV1(params: {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	try {
		const result = await searchWithKagiV1(params.query, {
			limit: numResults,
			recency: params.recency,
			signal: params.signal,
		});

		return {
			provider: "kagi-v1",
			sources: toSearchSources(result.sources, numResults),
			relatedQuestions: result.relatedQuestions.length > 0 ? result.relatedQuestions : undefined,
			requestId: result.requestId,
			answer: result.answer,
		};
	} catch (err) {
		if (err instanceof KagiV1ApiError) {
			throw new SearchProviderError("kagi-v1", err.message, err.statusCode);
		}
		throw err;
	}
}

/** Search provider for Kagi V1 web search. */
export class KagiV1Provider extends SearchProvider {
	readonly id = "kagi-v1";
	readonly label = "Kagi V1";

	async isAvailable() {
		try {
			return !!(await findKagiApiKey());
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKagiV1({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
