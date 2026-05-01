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

import { ANTHROPIC_THINKING } from "../stream";
import type { Api, Context, Model, SimpleStreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";
import { createProviderErrorMessage } from "./shared/error-message";

export type KimiApiFormat = "openai" | "anthropic";

// Note: Anthropic SDK appends /v1/messages, so base URL should not include /v1
const KIMI_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding";

export interface KimiOptions extends SimpleStreamOptions {
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
	const stream = new AssistantMessageEventStream();
	const format = options?.format ?? "anthropic";

	// Async IIFE to handle header fetching and stream piping
	(async () => {
		try {
			const mergedHeaders = { ...getKimiCommonHeaders(), ...options?.headers };

			if (format === "anthropic") {
				// Create a synthetic Anthropic model pointing to Kimi's endpoint
				const anthropicModel: Model<"anthropic-messages"> = {
					id: model.id,
					name: model.name,
					api: "anthropic-messages",
					provider: model.provider,
					baseUrl: KIMI_ANTHROPIC_BASE_URL,
					headers: mergedHeaders,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
				};

				// Calculate thinking budget from reasoning level
				const reasoning = options?.reasoning;
				const reasoningEffort = reasoning;
				const thinkingEnabled = !!reasoningEffort && model.reasoning;
				const thinkingBudget = reasoningEffort
					? (options?.thinkingBudgets?.[reasoningEffort] ?? ANTHROPIC_THINKING[reasoningEffort])
					: undefined;

				const innerStream = streamAnthropic(anthropicModel, context, {
					apiKey: options?.apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000),
					signal: options?.signal,
					headers: mergedHeaders,
					sessionId: options?.sessionId,
					onPayload: options?.onPayload,
					thinkingEnabled,
					thinkingBudgetTokens: thinkingBudget,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			} else {
				// OpenAI format - use original model with Kimi headers
				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(model, context, {
					apiKey: options?.apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens,
					signal: options?.signal,
					headers: mergedHeaders,
					sessionId: options?.sessionId,
					onPayload: options?.onPayload,
					reasoning: reasoningEffort,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
