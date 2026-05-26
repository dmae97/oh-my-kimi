import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";
import { fetchAntigravityDiscoveryModels } from "../utils/discovery/antigravity";
import { fetchGeminiModels } from "../utils/discovery/gemini";
import { fetchVertexOpenAIModels } from "../utils/discovery/vertex";

export interface GoogleModelManagerConfig {
	apiKey?: string;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
	project?: string;
	location?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
}

const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		...(apiKey ? { fetchDynamicModels: () => fetchGeminiModels({ apiKey }) } : undefined),
	};
}

export function googleVertexModelManagerOptions(config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	const project = resolveVertexProject(config);
	const location = resolveVertexLocation(config);
	return {
		providerId: "google-vertex",
		...(project && location
			? {
					staticModels: [],
					fetchDynamicModels: () =>
						fetchVertexOpenAIModels({
							project,
							location,
							signal: config?.signal,
							fetch: config?.fetch,
						}),
				}
			: undefined),
	};
}
function resolveVertexProject(config?: GoogleVertexModelManagerConfig): string | undefined {
	const project = config?.project ?? Bun.env.GOOGLE_CLOUD_PROJECT ?? Bun.env.GCP_PROJECT ?? Bun.env.GCLOUD_PROJECT;
	const trimmed = project?.trim();
	return trimmed ? trimmed : undefined;
}

function resolveVertexLocation(config?: GoogleVertexModelManagerConfig): string | undefined {
	const location =
		config?.location ?? Bun.env.GOOGLE_VERTEX_LOCATION ?? Bun.env.GOOGLE_CLOUD_LOCATION ?? Bun.env.VERTEX_LOCATION;
	const trimmed = location?.trim();
	return trimmed ? trimmed : undefined;
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	return {
		providerId: "google-antigravity",
		...(token
			? {
					fetchDynamicModels: () =>
						fetchAntigravityDiscoveryModels({
							token,
							endpoint: config?.endpoint,
						}),
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const endpoint = config?.endpoint ?? CLOUD_CODE_ASSIST_ENDPOINT;
	return {
		providerId: "google-gemini-cli",
		...(token
			? {
					fetchDynamicModels: async () => {
						const models = await fetchAntigravityDiscoveryModels({
							token,
							endpoint,
						});
						if (models === null) {
							return null;
						}
						return models.map(m => ({
							...m,
							provider: "google-gemini-cli" as const,
							baseUrl: endpoint,
						}));
					},
				}
			: undefined),
	};
}
