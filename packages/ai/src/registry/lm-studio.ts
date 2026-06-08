import { lmStudioModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const PROVIDER_ID = "lm-studio";
export const DEFAULT_LOCAL_TOKEN = "lm-studio-local";

export async function loginLmStudio(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_ID} login requires onPrompt callback`);
	}

	const apiKey = await options.onPrompt({
		message: "Optional: Paste LM Studio API key (to customize endpoint URL, set LM_STUDIO_BASE_URL env var)",
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}

export const lmStudioProvider = {
	id: "lm-studio",
	name: "LM Studio (Local OpenAI-compatible)",
	defaultModel: "llama-3-8b",
	createModelManagerOptions: (config: ModelManagerConfig) => lmStudioModelManagerOptions(config),
	allowUnauthenticated: true,
	envKeys: "LM_STUDIO_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginLmStudio(cb),
} as const satisfies ProviderDefinition;
