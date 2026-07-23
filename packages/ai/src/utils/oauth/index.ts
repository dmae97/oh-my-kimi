/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 * - OpenAI Codex (ChatGPT Plus/Pro)
 * - Qwen (Qwen Code subscription)
 * - Grok (xAI, via the local grok-oauth-proxy)
 * - xAI (native Grok OAuth, SuperGrok or X Premium+)
 * - Cursor (Claude, GPT, etc. via Cursor subscription)
 * - GitLab Duo (Code Suggestions, Chat)
 * - Kimi Code (Moonshot AI)
 * - Perplexity (Pro/Max)
 * - Google Cloud Code Assist (Gemini CLI)
 * - Google Antigravity (Gemini 3, Claude, GPT-OSS)
 * - OpenCode Zen / Go
 * - Devin (Cognition AI)
 */

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.ts";
// Cursor
export {
	CURSOR_OAUTH_PROVIDER_ID,
	cursorOAuthProvider,
	generateCursorAuthParams,
	isCursorTokenExpiringSoon,
	loginCursor,
	refreshCursorToken,
} from "./cursor.ts";
export * from "./device-code.ts";
// Devin
export {
	DEVIN_OAUTH_PROVIDER_ID,
	devinOAuthProvider,
	loginDevin,
} from "./devin.ts";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.ts";
// GitLab Duo
export {
	GITLAB_DUO_OAUTH_PROVIDER_ID,
	gitlabDuoOAuthProvider,
	loginGitLabDuo,
	refreshGitLabDuoToken,
} from "./gitlab-duo.ts";
// Google Antigravity
export {
	GOOGLE_ANTIGRAVITY_PROVIDER_ID,
	googleAntigravityOAuthProvider,
	loginAntigravity,
	refreshAntigravityToken,
} from "./google-antigravity.ts";
// Google Cloud Code Assist (Gemini CLI)
export {
	GOOGLE_GEMINI_CLI_PROVIDER_ID,
	googleGeminiCliOAuthProvider,
	loginGeminiCli,
	refreshGeminiCliToken,
} from "./google-gemini-cli.ts";
// Grok (xAI OAuth proxy)
export { GROK_PROXY_PROVIDER_ID, grokProxyOAuthProvider, loginGrokProxy } from "./grok-proxy.ts";
// Kimi Code (Moonshot AI)
export {
	KIMI_CODE_OAUTH_PROVIDER_ID,
	kimiCodeOAuthProvider,
	loginKimiCode,
	refreshKimiToken,
} from "./kimi.ts";
// OpenAI Codex (ChatGPT OAuth)
export {
	loginOpenAICodex,
	loginOpenAICodexDeviceCode,
	OPENAI_CODEX_BROWSER_LOGIN_METHOD,
	OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "./openai-codex.ts";
// OpenCode Zen / Go
export {
	OPENCODE_GO_PROVIDER_ID,
	OPENCODE_ZEN_PROVIDER_ID,
	opencodeGoOAuthProvider,
	opencodeZenOAuthProvider,
} from "./opencode.ts";
// Perplexity
export {
	loginPerplexity,
	PERPLEXITY_OAUTH_PROVIDER_ID,
	perplexityOAuthProvider,
} from "./perplexity.ts";
// Qwen (Qwen Code subscription)
export {
	loginQwen,
	normalizeQwenBaseUrl,
	QWEN_OAUTH_PROVIDER_ID,
	qwenOAuthProvider,
	refreshQwenToken,
} from "./qwen.ts";
export * from "./types.ts";
// xAI (native Grok OAuth)
export {
	isXAIAccessTokenExpiring,
	loginXAI,
	refreshXAIToken,
	XAI_OAUTH_PROVIDER_ID,
	xaiOAuthProvider,
} from "./xai.ts";
// Zhipu Coding Plan (智谱)
export {
	loginZhipuCodingPlan,
	ZHIPU_CODING_PLAN_PROVIDER_ID,
	zhipuCodingPlanOAuthProvider,
} from "./zhipu-coding-plan.ts";

// ============================================================================
// Provider Registry
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.ts";
import { cursorOAuthProvider } from "./cursor.ts";
import { devinOAuthProvider } from "./devin.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { gitlabDuoOAuthProvider } from "./gitlab-duo.ts";
import { googleAntigravityOAuthProvider } from "./google-antigravity.ts";
import { googleGeminiCliOAuthProvider } from "./google-gemini-cli.ts";
import { grokProxyOAuthProvider } from "./grok-proxy.ts";
import { kimiCodeOAuthProvider } from "./kimi.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import { opencodeGoOAuthProvider, opencodeZenOAuthProvider } from "./opencode.ts";
import { perplexityOAuthProvider } from "./perplexity.ts";
import { qwenOAuthProvider } from "./qwen.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";
import { xaiOAuthProvider } from "./xai.ts";
import { zhipuCodingPlanOAuthProvider } from "./zhipu-coding-plan.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	cursorOAuthProvider,
	devinOAuthProvider,
	githubCopilotOAuthProvider,
	gitlabDuoOAuthProvider,
	googleAntigravityOAuthProvider,
	googleGeminiCliOAuthProvider,
	grokProxyOAuthProvider,
	kimiCodeOAuthProvider,
	openaiCodexOAuthProvider,
	opencodeGoOAuthProvider,
	opencodeZenOAuthProvider,
	perplexityOAuthProvider,
	qwenOAuthProvider,
	xaiOAuthProvider,
	zhipuCodingPlanOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Unregister an OAuth provider.
 *
 * If the provider is built-in, restores the built-in implementation.
 * Custom providers are removed completely.
 */
export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

/**
 * Reset OAuth providers to built-ins.
 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

/**
 * Refresh token for any OAuth provider.
 * @deprecated Use getOAuthProvider(id).refreshToken() instead
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
