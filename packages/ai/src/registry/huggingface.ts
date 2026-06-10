import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL =
	"https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained";
const API_BASE_URL = "https://router.huggingface.co/v1";
const VALIDATION_MODEL = "openai/gpt-oss-120b";

export async function loginHuggingface(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Hugging Face login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions:
			"Create/copy a token with Make calls to Inference Providers permission (usable as HUGGINGFACE_HUB_TOKEN or HF_TOKEN)",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Hugging Face token (HUGGINGFACE_HUB_TOKEN / HF_TOKEN)",
		placeholder: "hf_...",
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
		provider: "Hugging Face",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

export const huggingfaceProvider = {
	id: "huggingface",
	name: "Hugging Face Inference",
	login: (cb: OAuthLoginCallbacks) => loginHuggingface(cb),
} as const satisfies ProviderDefinition;
