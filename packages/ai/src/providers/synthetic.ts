/**
 * Synthetic provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Synthetic offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.synthetic.new/openai/v1/chat/completions
 * - Anthropic: https://api.synthetic.new/anthropic/v1/messages
 *
 * @see https://dev.synthetic.new/docs/api/overview
 */

import { ANTHROPIC_THINKING } from "../stream";
import type { Api, Context, Model, SimpleStreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";
import { createProviderErrorMessage } from "./shared/error-message";

export type SyntheticApiFormat = "openai" | "anthropic";

const SYNTHETIC_NEW_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_NEW_ANTHROPIC_BASE_URL = "https://api.synthetic.new/anthropic";

export interface SyntheticOptions extends SimpleStreamOptions {
	/** API format: "openai" or "anthropic". Default: "openai" */
	format?: SyntheticApiFormat;
}

/**
 * Stream from Synthetic, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async processing happens internally.
 */
export function streamSynthetic(
	model: Model<"openai-completions">,
	context: Context,
	options?: SyntheticOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const format = options?.format ?? "openai";

	// Async IIFE to handle stream piping
	(async () => {
		try {
			const mergedHeaders = options?.headers ?? {};

			if (format === "anthropic") {
				// Create a synthetic Anthropic model pointing to Synthetic's endpoint
				const anthropicModel: Model<"anthropic-messages"> = {
					id: model.id,
					name: model.name,
					api: "anthropic-messages",
					provider: model.provider,
					baseUrl: SYNTHETIC_NEW_ANTHROPIC_BASE_URL,
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
				// OpenAI format - use original model with Synthetic headers
				const syntheticModel: Model<"openai-completions"> = {
					...model,
					baseUrl: SYNTHETIC_NEW_BASE_URL,
					headers: mergedHeaders,
				};

				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(syntheticModel, context, {
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
 * Check if a model is a Synthetic model.
 */
export function isSyntheticModel(model: Model<Api>): boolean {
	return model.provider === "synthetic";
}
