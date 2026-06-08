/**
 * Zhipu Coding Plan login flow.
 *
 * GLM Coding Plan provides an OpenAI-compatible API on the dedicated coding
 * endpoint. API docs: https://docs.bigmodel.cn/cn/coding-plan/quick-start
 *
 * Simple API key flow:
 * 1. User gets a Coding Plan API key from https://bigmodel.cn/coding-plan/personal/overview
 * 2. User pastes the API key into the CLI
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://bigmodel.cn/coding-plan/personal/overview";
const API_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-5.1";

/**
 * Login to Zhipu Coding Plan.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginZhipuCodingPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Zhipu Coding Plan login requires onPrompt callback");
	}

	// Open browser to API keys page
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Coding Plan dashboard",
	});

	// Prompt user to paste their API key
	const apiKey = await options.onPrompt({
		message: "Paste your Zhipu API key",
		placeholder: "<id>.<secret>",
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
		provider: "Zhipu",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});
	return trimmed;
}
