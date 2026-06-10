/**
 * The single Model constructor. Thinking metadata and the resolved compat
 * record are materialized here, exactly once per spec — request handlers read
 * `model.compat` fields and perform zero URL parsing and zero compat
 * allocation per request.
 */
import { buildAnthropicCompat } from "./compat/anthropic";
import { buildOpenAICompat, buildOpenAIResponsesCompat } from "./compat/openai";
import { enrichModelThinking } from "./model-thinking";
import type { Api, CompatOf, Model, ModelSpec } from "./types";

export function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	const enriched = enrichModelThinking(spec);
	return {
		...enriched,
		compat: buildCompat(enriched) as CompatOf<TApi>,
		compatConfig: enriched.compat,
	} as Model<TApi>;
}

function buildCompat(spec: ModelSpec<Api>): CompatOf<Api> {
	switch (spec.api) {
		case "openai-completions":
			return buildOpenAICompat(spec as ModelSpec<"openai-completions">);
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return buildOpenAIResponsesCompat(spec as ModelSpec<"openai-responses">);
		case "anthropic-messages":
			return buildAnthropicCompat(spec as ModelSpec<"anthropic-messages">);
		default:
			return undefined;
	}
}
