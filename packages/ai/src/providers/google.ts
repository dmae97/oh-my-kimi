import { GoogleGenAI } from "@google/genai";
import { getEnvApiKey } from "../stream";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { buildGoogleGenerateContentParams, type GoogleSharedStreamOptions, streamGoogleGenAI } from "./google-shared";

export type GoogleOptions = GoogleSharedStreamOptions;

export const streamGoogle: StreamFunction<"google-generative-ai"> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream =>
	streamGoogleGenAI({
		model,
		options,
		api: "google-generative-ai",
		prepare: () => {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider);
			const client = createClient(model, apiKey);
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			const url = model.baseUrl ? `${model.baseUrl}/models/${model.id}:streamGenerateContent` : undefined;
			return { client, params, url };
		},
	});

function createClient(model: Model<"google-generative-ai">, apiKey?: string): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	if (model.headers) {
		httpOptions.headers = model.headers;
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}
