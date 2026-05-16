// Ported from NousResearch/hermes-agent (MIT) — agent/transports/codex.py:182-193,
// agent/codex_responses_adapter.py:247-311. Logic EXTRACTED into a dedicated xAI
// adapter so the generic OpenAI Responses path stays provider-agnostic and the
// OpenAI Codex Responses path is unaffected.

import type { Context, Model, StreamFunction } from "../types";
import {
	getOpenAIResponsesCacheSessionId,
	type OpenAIResponsesOptions,
	streamOpenAIResponses,
} from "./openai-responses";

/**
 * xAI Grok Responses adapter (SuperGrok OAuth path).
 *
 * Three xAI-specific behaviors vs the generic OpenAI Responses adapter:
 *
 *  1. `x-grok-conv-id` header + body `prompt_cache_key` route prompt-cache
 *     hits on xAI's edge. Hermes uses both (agent/transports/codex.py:182-193).
 *     The header is undocumented by xAI; `previous_response_id` is the
 *     documented alternative — switch if xAI deprecates the header.
 *  2. includeEncryptedReasoning=false — xAI's /v1/responses rejects replayed
 *     `encrypted_content` blobs minted under SuperGrok OAuth.
 *  3. filterReasoningHistory=true — strip `type: "reasoning"` items from
 *     replayed conversation history; the blob inside is non-replayable under
 *     OAuth and the wrapper item 404s without it (store=false; server cannot
 *     resolve by id).
 *
 * Everything else is the generic OpenAI Responses transport. The xAI bearer
 * token arrives in `options.apiKey` via AuthStorage.getApiKey() upstream, and
 * the xAI base URL (`https://api.x.ai/v1`) arrives via `model.baseUrl` from
 * the provider registry — not routed through this wrapper.
 */
export const streamXAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions = {},
) => {
	const cacheSessionId = getOpenAIResponsesCacheSessionId(options);

	const xaiHeaders: Record<string, string> = { ...options?.headers };
	if (cacheSessionId) {
		xaiHeaders["x-grok-conv-id"] = cacheSessionId;
	}

	const xaiBody: Record<string, unknown> = { ...(options?.extraBody ?? {}) };
	if (cacheSessionId) {
		xaiBody.prompt_cache_key = cacheSessionId;
	}

	const xaiOptions: OpenAIResponsesOptions = {
		...options,
		headers: xaiHeaders,
		extraBody: xaiBody,
		includeEncryptedReasoning: false,
		filterReasoningHistory: true,
	};

	return streamOpenAIResponses(model, context, xaiOptions);
};
