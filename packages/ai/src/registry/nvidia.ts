import * as AIError from "../error";
import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://org.ngc.nvidia.com/setup/personal-keys";
const API_BASE_URL = "https://integrate.api.nvidia.com/v1";
const VALIDATION_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";
const PROVIDER_ID = "nvidia";

export async function loginNvidia(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("NVIDIA");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from NVIDIA NGC Personal Keys",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your NVIDIA API key",
		placeholder: "nvapi-...",
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.("Validating API key (optional)...");
	try {
		await validateOpenAICompatibleApiKey({
			provider: PROVIDER_ID,
			apiKey: trimmed,
			baseUrl: API_BASE_URL,
			model: VALIDATION_MODEL,
			signal: options.signal,
			fetch: options.fetch,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const statusMatch = message.match(/\((\d{3})\)/);
		const statusCode = statusMatch?.[1];
		if (statusCode === "401" || statusCode === "403") {
			throw error;
		}
		options.onProgress?.("Skipping NVIDIA validation endpoint; continuing with provided API key.");
	}

	return trimmed;
}

export const nvidiaProvider = {
	id: "nvidia",
	name: "NVIDIA",
	login: (cb: OAuthLoginCallbacks) => loginNvidia(cb),
} as const satisfies ProviderDefinition;
