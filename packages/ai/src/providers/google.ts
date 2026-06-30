import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { modelSupportsInteractions, resolveInteractionDispatch, streamGoogleInteractions } from "./google-interactions";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";

export type GoogleOptions = GoogleSharedStreamOptions;

const DEFAULT_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const streamGoogle: StreamFunction<"google-generative-ai"> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(
			undefined,
			"Google Generative AI requires an API key (GEMINI_API_KEY or options.apiKey).",
		);
	}

	const runGenerateContent = (): AssistantMessageEventStream =>
		streamGoogleGenAI({
			model,
			options,
			api: "google-generative-ai",
			prepare: (): GoogleGenAIRequestPlan => {
				const params = buildGoogleGenerateContentParams(model, context, options ?? {});
				// `model.baseUrl` already includes the API version segment when set (mirrors the
				// `apiVersion: ""` reset that the SDK relied on for custom base URLs).
				const base = model.baseUrl?.trim() || DEFAULT_GENERATIVE_LANGUAGE_BASE;
				const url = `${base}/models/${model.id}:streamGenerateContent?alt=sse`;
				const headers: Record<string, string> = {
					"x-goog-api-key": apiKey,
					...(model.headers ?? {}),
					...(options?.headers ?? {}),
				};
				return { params, url, headers, fetch: options?.fetch };
			},
		});

	// Default Gemini 3+ on the official endpoint onto Interactions (custom proxy base URLs keep
	// generateContent, which serves the full catalog). The fallback recovers ids the endpoint rejects.
	const trimmedBase = model.baseUrl?.trim();
	let officialEndpoint = !trimmedBase;
	if (trimmedBase) {
		try {
			officialEndpoint = new URL(trimmedBase).hostname === "generativelanguage.googleapis.com";
		} catch {
			officialEndpoint = false;
		}
	}
	const { useInteractions, auto, anchor, state } = resolveInteractionDispatch({
		context,
		options,
		provider: model.provider,
		autoEligible: officialEndpoint && modelSupportsInteractions(model),
	});
	if (!useInteractions) return runGenerateContent();

	return streamGoogleInteractions({
		model,
		context,
		options,
		api: "google-generative-ai",
		anchor,
		state,
		prepare: () => ({
			url: `${trimmedBase || DEFAULT_GENERATIVE_LANGUAGE_BASE}/interactions`,
			headers: {
				"x-goog-api-key": apiKey,
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			},
			fetch: options?.fetch,
		}),
		fallback: auto ? runGenerateContent : undefined,
	});
};
