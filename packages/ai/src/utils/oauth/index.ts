// ============================================================================
// High-level API
// ============================================================================
import { refreshAnthropicToken } from "./anthropic";
import { refreshCursorToken } from "./cursor";
import { refreshGitHubCopilotToken } from "./github-copilot";
import { refreshGitLabDuoToken } from "./gitlab-duo";
import { refreshAntigravityToken } from "./google-antigravity";
import { refreshGoogleCloudToken } from "./google-gemini-cli";
import { refreshKimiToken } from "./kimi";
import { refreshOpenAICodexToken } from "./openai-codex";
import type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";

/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 * - Google Cloud Code Assist (Gemini CLI)
 * - Antigravity (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * - Kimi Code
 * - Kilo Gateway
 * - Kagi
 * - Cerebras
 * - Hugging Face Inference
 * - Synthetic
 * - Perplexity (Pro/Max — desktop app extraction or manual cookie)
 * - NVIDIA
 * - NanoGPT
 * - Venice
 * - vLLM
 * - ZenMux
 * - Alibaba Coding Plan
 */
// Alibaba Coding Plan
export { loginAlibabaCodingPlan } from "./alibaba-coding-plan";
// Anthropic
export { loginAnthropic, refreshAnthropicToken } from "./anthropic";
// Cerebras (API key)
export { loginCerebras } from "./cerebras";
// Cloudflare AI Gateway (API key)
export { loginCloudflareAiGateway } from "./cloudflare-ai-gateway";
// Cursor
export {
	generateCursorAuthParams,
	isCursorTokenExpiringSoon,
	loginCursor,
	pollCursorAuth,
	refreshCursorToken,
} from "./cursor";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot";
// GitLab Duo
export { loginGitLabDuo, refreshGitLabDuoToken } from "./gitlab-duo";
// Google Antigravity
export { loginAntigravity, refreshAntigravityToken } from "./google-antigravity";
// Google Gemini CLI
export { loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli";
// Hugging Face Inference (API key)
export { loginHuggingface } from "./huggingface";
// Kagi (API key)
export { loginKagi } from "./kagi";
// Kilo Gateway
export { loginKilo } from "./kilo";
// Kimi Code
export { loginKimi, refreshKimiToken } from "./kimi";
// LiteLLM (API key)
export { loginLiteLLM } from "./litellm";
// LM Studio (optional API key)
export { DEFAULT_LOCAL_TOKEN, loginLmStudio } from "./lm-studio";
// MiniMax Coding Plan (API key)
export { loginMiniMaxCode, loginMiniMaxCodeCn } from "./minimax-code";
// Moonshot (API key)
export { loginMoonshot } from "./moonshot";
// NanoGPT (API key)
export { loginNanoGPT } from "./nanogpt";
// NVIDIA (API key)
export { loginNvidia } from "./nvidia";
// Ollama (optional API key)
export { loginOllama } from "./ollama";
export { loginOllamaCloud } from "./ollama-cloud";
export type { OpenAICodexLoginOptions } from "./openai-codex";
// OpenAI Codex (ChatGPT OAuth)
export { loginOpenAICodex, refreshOpenAICodexToken } from "./openai-codex";
// OpenCode Zen / OpenCode Go (API key)
export { loginOpenCode } from "./opencode";
// Parallel (API key)
export { loginParallel } from "./parallel";
// Perplexity
export { loginPerplexity } from "./perplexity";
// Qianfan (API key)
export { loginQianfan } from "./qianfan";
// Qwen Portal (OAuth token/API key)
export { loginQwenPortal } from "./qwen-portal";
// Synthetic (API key)
export { loginSynthetic } from "./synthetic";
// Tavily (API key)
export { loginTavily } from "./tavily";
// Together (API key)
export { loginTogether } from "./together";
export * from "./types";
// Venice (API key)
export { loginVenice } from "./venice";
// Vercel AI Gateway (API key)
export { loginVercelAiGateway } from "./vercel-ai-gateway";
// vLLM (API key)
export { loginVllm } from "./vllm";
// Xiaomi MiMo (API key)
export { loginXiaomi } from "./xiaomi";
// Z.AI (API key)
export { loginZai } from "./zai";
// ZenMux (API key)
export { loginZenMux } from "./zenmux";

const builtInOAuthProviders: OAuthProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		available: true,
	},
	{
		id: "alibaba-coding-plan",
		name: "Alibaba Coding Plan",
		available: true,
	},
	{
		id: "openai-codex",
		name: "ChatGPT Plus/Pro (Codex Subscription)",
		available: true,
	},
	{
		id: "gitlab-duo",
		name: "GitLab Duo",
		available: true,
	},
	{
		id: "kimi-code",
		name: "Kimi Code",
		available: true,
	},
	{
		id: "kilo",
		name: "Kilo Gateway",
		available: true,
	},
	{
		id: "kagi",
		name: "Kagi",
		available: true,
	},
	{
		id: "cerebras",
		name: "Cerebras",
		available: true,
	},
	{
		id: "github-copilot",
		name: "GitHub Copilot",
		available: true,
	},
	{
		id: "google-gemini-cli",
		name: "Google Cloud Code Assist (Gemini CLI)",
		available: true,
	},
	{
		id: "google-antigravity",
		name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
		available: true,
	},
	{
		id: "cursor",
		name: "Cursor (Claude, GPT, etc.)",
		available: true,
	},
	{
		id: "litellm",
		name: "LiteLLM",
		available: true,
	},
	{
		id: "lm-studio",
		name: "LM Studio (Local OpenAI-compatible)",
		available: true,
	},
	{
		id: "ollama",
		name: "Ollama (Local OpenAI-compatible)",
		available: true,
	},
	{
		id: "ollama-cloud",
		name: "Ollama Cloud",
		available: true,
	},
	{
		id: "huggingface",
		name: "Hugging Face Inference",
		available: true,
	},
	{
		id: "synthetic",
		name: "Synthetic",
		available: true,
	},
	{
		id: "tavily",
		name: "Tavily",
		available: true,
	},
	{
		id: "together",
		name: "Together",
		available: true,
	},
	{
		id: "xiaomi",
		name: "Xiaomi MiMo",
		available: true,
	},
	{
		id: "opencode-zen",
		name: "OpenCode Zen",
		available: true,
	},
	{
		id: "opencode-go",
		name: "OpenCode Go",
		available: true,
	},
	{
		id: "zai",
		name: "Z.AI (GLM Coding Plan)",
		available: true,
	},
	{
		id: "minimax-code",
		name: "MiniMax Coding Plan (International)",
		available: true,
	},
	{
		id: "minimax-code-cn",
		name: "MiniMax Coding Plan (China)",
		available: true,
	},
	{
		id: "moonshot",
		name: "Moonshot (Kimi API)",
		available: true,
	},
	{
		id: "nanogpt",
		name: "NanoGPT",
		available: true,
	},
	{
		id: "parallel",
		name: "Parallel",
		available: true,
	},
	{
		id: "perplexity",
		name: "Perplexity (Pro/Max)",
		available: true,
	},
	{
		id: "nvidia",
		name: "NVIDIA",
		available: true,
	},
	{
		id: "qwen-portal",
		name: "Qwen Portal",
		available: true,
	},
	{
		id: "qianfan",
		name: "Qianfan",
		available: true,
	},
	{
		id: "venice",
		name: "Venice",
		available: true,
	},
	{
		id: "zenmux",
		name: "ZenMux",
		available: true,
	},
	{
		id: "vllm",
		name: "vLLM (Local OpenAI-compatible)",
		available: true,
	},
	{
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		available: true,
	},
	{
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		available: true,
	},
];

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/**
 * Register a custom OAuth provider.
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

/**
 * Get a custom OAuth provider by ID.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/**
 * Remove all custom OAuth providers registered by a source.
 */
export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
		}
	}
}

/**
 * Refresh token for any OAuth provider.
 * Saves the new credentials and returns the new access token.
 */
export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	let newCredentials: OAuthCredentials;
	switch (provider) {
		case "anthropic":
			newCredentials = await refreshAnthropicToken(credentials.refresh);
			break;
		case "github-copilot":
			newCredentials = await refreshGitHubCopilotToken(credentials.refresh, credentials.enterpriseUrl);
			break;
		case "google-gemini-cli":
			if (!credentials.projectId) {
				throw new Error("Google Cloud credentials missing projectId");
			}
			newCredentials = await refreshGoogleCloudToken(credentials.refresh, credentials.projectId);
			break;
		case "google-antigravity":
			if (!credentials.projectId) {
				throw new Error("Antigravity credentials missing projectId");
			}
			newCredentials = await refreshAntigravityToken(credentials.refresh, credentials.projectId);
			break;
		case "openai-codex":
			newCredentials = await refreshOpenAICodexToken(credentials.refresh);
			break;
		case "kimi-code":
			newCredentials = await refreshKimiToken(credentials.refresh);
			break;
		case "kilo":
			newCredentials = credentials;
			break;
		case "gitlab-duo":
			newCredentials = await refreshGitLabDuoToken(credentials);
			break;
		case "cursor":
			newCredentials = await refreshCursorToken(credentials.refresh);
			break;
		case "perplexity":
		case "huggingface":
		case "opencode-zen":
		case "opencode-go":
		case "cerebras":
		case "nvidia":
		case "nanogpt":
		case "synthetic":
		case "together":
		case "litellm":
		case "lm-studio":
		case "ollama":
		case "ollama-cloud":
		case "xiaomi":
		case "zai":
		case "qianfan":
		case "venice":
		case "minimax-code":
		case "minimax-code-cn":
		case "moonshot":
		case "kagi":
		case "cloudflare-ai-gateway":
		case "vercel-ai-gateway":
		case "qwen-portal":
		case "zenmux":
		case "vllm":
			// API keys / static bearer tokens don't expire, return as-is
			newCredentials = credentials;
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}
	return newCredentials;
}
function getPerplexityJwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000 - 5 * 60_000;
	} catch {
		return undefined;
	}
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * For providers that need credential metadata at request time, returns JSON-encoded credentials
 * plus refresh/expiry metadata for proactive refresh support.
 * @returns API key string, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	let creds = credentials[provider];
	if (!creds) {
		return null;
	}

	if (provider === "perplexity") {
		const normalizedExpires =
			creds.expires > 0 && creds.expires < 10_000_000_000 ? creds.expires * 1000 : creds.expires;
		const jwtExpiry = getPerplexityJwtExpiryMs(creds.access);
		const expires = jwtExpiry && jwtExpiry > normalizedExpires ? jwtExpiry : normalizedExpires;
		if (expires !== creds.expires) {
			creds = { ...creds, expires };
		}
	}
	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await refreshOAuthToken(provider, creds);
		} catch (refreshError) {
			if (provider === "perplexity") {
				const jwtExpiry = getPerplexityJwtExpiryMs(creds.access);
				if (jwtExpiry && Date.now() < jwtExpiry) {
					const fallbackCredentials = { ...creds, expires: jwtExpiry };
					return { newCredentials: fallbackCredentials, apiKey: fallbackCredentials.access };
				}
			}
			const reason = refreshError instanceof Error ? refreshError.message : String(refreshError);
			throw new Error(`Failed to refresh OAuth token for ${provider}: ${reason}`);
		}
	}
	// For providers that need request-time credential metadata, return JSON.
	const needsStructuredApiKey =
		provider === "github-copilot" || provider === "google-gemini-cli" || provider === "google-antigravity";
	const apiKey = needsStructuredApiKey
		? JSON.stringify({
				token: creds.access,
				enterpriseUrl: creds.enterpriseUrl,
				projectId: creds.projectId,
				refreshToken: creds.refresh,
				expiresAt: creds.expires,
				email: creds.email,
				accountId: creds.accountId,
			})
		: creds.access;
	return { newCredentials: creds, apiKey };
}

/**
 * Get list of OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	const customProviders = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
	}));
	return [...builtInOAuthProviders, ...customProviders];
}
