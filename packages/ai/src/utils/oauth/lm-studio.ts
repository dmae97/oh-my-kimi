/**
 * LM Studio login flow.
 *
 * LM Studio provides an OpenAI-compatible API at a local base URL.
 * It usually runs unauthenticated but can be configured to require a bearer token.
 *
 * This flow stores an API-key-style credential used by `/login` and auth storage.
 */

import type { OAuthController, OAuthProvider } from "./types";

const PROVIDER_ID: OAuthProvider = "lm-studio";
export const DEFAULT_LOCAL_TOKEN = "lm-studio-local";

/**
 * Login to LM Studio.
 *
 * Opens LM Studio API docs, prompts for an optional token,
 * and returns a stored key value.
 */
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
