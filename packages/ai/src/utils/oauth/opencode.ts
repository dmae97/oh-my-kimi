/**
 * OpenCode Zen / OpenCode Go login flow.
 *
 * OpenCode is a subscription service providing access to various AI models
 * (GPT-5.x, Claude 4.x, Gemini 3, etc.) through a unified API.
 * This is an API key flow: open browser → login → copy key → paste back.
 */
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const AUTH_URL = "https://opencode.ai/auth";

export const OPENCODE_ZEN_PROVIDER_ID = "opencode-zen";
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/** Login to OpenCode (shared by Zen and Go). */
async function loginOpenCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (!callbacks.onPrompt) {
		throw new Error("OpenCode login requires interactive prompt support");
	}

	callbacks.onAuth({
		url: AUTH_URL,
		instructions: "Log in and copy your API key",
	});

	const apiKey = await callbacks.onPrompt({
		message: "Paste your OpenCode API key",
		placeholder: "sk-...",
	});

	if (callbacks.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	// OpenCode keys don't expire; store as non-expiring credential
	return {
		access: trimmed,
		refresh: trimmed,
		expires: Number.MAX_SAFE_INTEGER,
	};
}

export const opencodeZenOAuthProvider: OAuthProviderInterface = {
	id: OPENCODE_ZEN_PROVIDER_ID,
	name: "OpenCode Zen",
	login: loginOpenCode,
	refreshToken: (credentials: OAuthCredentials) => Promise.resolve(credentials),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};

export const opencodeGoOAuthProvider: OAuthProviderInterface = {
	id: OPENCODE_GO_PROVIDER_ID,
	name: "OpenCode Go",
	login: loginOpenCode,
	refreshToken: (credentials: OAuthCredentials) => Promise.resolve(credentials),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
