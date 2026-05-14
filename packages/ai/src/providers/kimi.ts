/**
 * Kimi Code provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Kimi offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.kimi.com/coding/v1/chat/completions
 * - Anthropic: https://api.kimi.com/coding/v1/messages
 *
 * The Anthropic API is generally more stable and recommended.
 * Note: Kimi calculates TPM rate limits based on max_tokens, not actual output.
 */

import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

// Note: Anthropic SDK appends /v1/messages, so base URL should not include /v1
const KIMI_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding";

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	/** API format: "openai" or "anthropic". Default: "anthropic" */
	format?: KimiApiFormat;
}

/**
 * Stream from Kimi Code, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async header fetching happens internally.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: KIMI_ANTHROPIC_BASE_URL,
		defaultFormat: "anthropic",
		extraHeaders: getKimiCommonHeaders,
	});
}

/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
