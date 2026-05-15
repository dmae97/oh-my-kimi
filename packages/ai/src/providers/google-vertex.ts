import { GoogleGenAI } from "@google/genai";
import { $env } from "@oh-my-pi/pi-utils";
import type { Context, FetchImpl, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { buildGoogleGenerateContentParams, type GoogleSharedStreamOptions, streamGoogleGenAI } from "./google-shared";

export interface GoogleVertexOptions extends GoogleSharedStreamOptions {
	project?: string;
	location?: string;
}

const API_VERSION = "v1";

export const streamGoogleVertex: StreamFunction<"google-vertex"> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream =>
	streamGoogleGenAI({
		model,
		options,
		api: "google-vertex",
		retainTextSignature: true,
		prepare: () => {
			const apiKey = resolveApiKey(options);
			const project = apiKey ? undefined : resolveProject(options);
			const location = apiKey ? undefined : resolveLocation(options);
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.fetch)
				: createClient(model, project!, location!, options?.fetch);
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			const url = apiKey
				? `https://aiplatform.googleapis.com/${API_VERSION}/publishers/google/models/${model.id}:streamGenerateContent`
				: `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent`;
			return { client, params, url };
		},
	});

function buildHttpOptions(
	model: Model<"google-vertex">,
	fetchOverride: FetchImpl | undefined,
): { headers?: Record<string, string>; fetch?: FetchImpl } | undefined {
	const options: { headers?: Record<string, string>; fetch?: FetchImpl } = {};
	if (model.headers) {
		options.headers = { ...model.headers };
	}
	if (fetchOverride) {
		options.fetch = fetchOverride;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	fetchOverride: FetchImpl | undefined,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, fetchOverride),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	fetchOverride: FetchImpl | undefined,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, fetchOverride),
	});
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	// options.apiKey may contain sentinel values like "<authenticated>" or "N/A"
	// leaked from the agent loop — only use it if it looks like a real API key.
	const optKey = options?.apiKey;
	const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
	return realKey || $env.GOOGLE_CLOUD_API_KEY;
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || $env.GOOGLE_CLOUD_PROJECT || $env.GCLOUD_PROJECT;
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || $env.GOOGLE_CLOUD_LOCATION;
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}
