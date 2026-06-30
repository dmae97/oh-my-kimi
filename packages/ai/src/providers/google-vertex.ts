import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { getVertexAccessToken, hasVertexBearerCredentialsHint } from "./google-auth";
import {
	type GoogleInteractionsPlan,
	modelSupportsInteractions,
	resolveInteractionDispatch,
	streamGoogleInteractions,
} from "./google-interactions";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";

export interface GoogleVertexOptions extends GoogleSharedStreamOptions {
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const INTERACTIONS_API_VERSION = "v1beta1";
const INTERACTIONS_API_REVISION = "2026-05-20";

export const streamGoogleVertex: StreamFunction<"google-vertex"> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const runGenerateContent = (): AssistantMessageEventStream =>
		streamGoogleGenAI({
			model,
			options,
			api: "google-vertex",
			retainTextSignature: true,
			prepare: async (): Promise<GoogleGenAIRequestPlan> => {
				const apiKey = resolveApiKey(options);
				const params = buildGoogleGenerateContentParams(model, context, options ?? {});
				params.config ||= {};
				if (!params.config.safetySettings) {
					params.config.safetySettings = [
						{
							category: "HARM_CATEGORY_HATE_SPEECH",
							threshold: "OFF",
						},
						{
							category: "HARM_CATEGORY_DANGEROUS_CONTENT",
							threshold: "OFF",
						},
						{
							category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
							threshold: "OFF",
						},
						{
							category: "HARM_CATEGORY_HARASSMENT",
							threshold: "OFF",
						},
					];
				}
				const baseHeaders: Record<string, string> = {
					...(model.headers ?? {}),
					...(options?.headers ?? {}),
				};
				// Vertex AI ignores a `serviceTier` request-body field (unlike the direct
				// Gemini API); priority must travel as a request header. Only `priority`
				// has a documented Vertex request control — `flex` has none, so it's a no-op.
				if (options?.serviceTier === "priority") {
					baseHeaders["X-Vertex-AI-LLM-Shared-Request-Type"] = "priority";
				}

				if (apiKey) {
					// Explicit `location` is a deliberate residency choice: honor it and let
					// a 404 surface. An ambient env-derived region falls back to the global
					// endpoint so a stray GOOGLE_*_LOCATION never breaks a previously-working
					// global-only request.
					const explicitLocation = options?.location;
					const location = explicitLocation ?? resolveAmbientLocation() ?? "global";
					const host = resolveEndpointHost(location);
					const path = `${API_VERSION}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
					const useGlobalFallback = !explicitLocation && host !== "aiplatform.googleapis.com";
					return {
						params,
						url: `https://${host}/${path}`,
						fallbackUrl: useGlobalFallback ? `https://aiplatform.googleapis.com/${path}` : undefined,
						headers: {
							...baseHeaders,
							"x-goog-api-key": apiKey,
						},
						fetch: options?.fetch,
					};
				}

				const project = resolveProject(options);
				const location = resolveLocation(options);
				const accessToken = await getVertexAccessToken({ signal: options?.signal, fetch: options?.fetch });
				const host = resolveEndpointHost(location);
				const url = `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
				return {
					params,
					url,
					headers: { ...baseHeaders, Authorization: `Bearer ${accessToken}` },
					fetch: options?.fetch,
				};
			},
		});

	// Default Gemini 3+ onto Interactions whenever a bearer credential source exists (ADC file,
	// `GOOGLE_APPLICATION_CREDENTIALS`, or an explicit access-token env). Interactions needs bearer
	// auth, so express API-key-only setups stay on generateContent — and an express key, when
	// present, still serves the generateContent fallback. Interactions always targets the official
	// global `aiplatform` host; the fallback also recovers ids the endpoint rejects.
	const { useInteractions, auto, anchor, state } = resolveInteractionDispatch({
		context,
		options,
		provider: model.provider,
		autoEligible: modelSupportsInteractions(model) && hasVertexBearerCredentialsHint(),
	});
	if (!useInteractions) return runGenerateContent();

	return streamGoogleInteractions({
		model,
		context,
		options,
		api: "google-vertex",
		anchor,
		state,
		prepare: async (): Promise<GoogleInteractionsPlan> => {
			const project = resolveProject(options);
			const accessToken = await getVertexAccessToken({ signal: options?.signal, fetch: options?.fetch });
			return {
				url: `https://aiplatform.googleapis.com/${INTERACTIONS_API_VERSION}/projects/${project}/locations/global/interactions`,
				headers: {
					...(model.headers ?? {}),
					...(options?.headers ?? {}),
					Authorization: `Bearer ${accessToken}`,
					"Api-Revision": INTERACTIONS_API_REVISION,
				},
				fetch: options?.fetch,
			};
		},
		fallback: auto ? runGenerateContent : undefined,
	});
};

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	// options.apiKey may contain sentinel values like "<authenticated>" or "N/A"
	// leaked from the agent loop — only use it if it looks like a real API key.
	const optKey = options?.apiKey;
	const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
	return realKey || $env.GOOGLE_CLOUD_API_KEY;
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	if (!project) {
		throw new AIError.ConfigurationError(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCP_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveEndpointHost(location: string): string {
	return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}
function resolveAmbientLocation(): string | undefined {
	return $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION || undefined;
}
function resolveOptionalLocation(options?: GoogleVertexOptions): string | undefined {
	return options?.location || resolveAmbientLocation();
}
function resolveLocation(options?: GoogleVertexOptions): string {
	const location = resolveOptionalLocation(options);
	if (!location) {
		throw new AIError.ConfigurationError(
			"Vertex AI requires a location. Set GOOGLE_VERTEX_LOCATION/GOOGLE_CLOUD_LOCATION/VERTEX_LOCATION or pass location in options.",
		);
	}
	return location;
}
