import { zaiModelManagerOptions } from "../provider-models/special";
import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const AUTH_URL = "https://z.ai/manage-apikey/apikey-list";
const API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-4.7";

export async function loginZai(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Z.AI login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Z.AI API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateOpenAICompatibleApiKey({
		provider: "Z.AI",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});
	return trimmed;
}

export const zaiProvider = {
	id: "zai",
	name: "Z.AI (GLM Coding Plan)",
	defaultModel: "glm-5.1",
	createModelManagerOptions: (config: ModelManagerConfig) => zaiModelManagerOptions(config),
	catalogDiscovery: { label: "zAI", envVars: ["ZAI_API_KEY"] },
	envKeys: "ZAI_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginZai(cb),
} as const satisfies ProviderDefinition;
