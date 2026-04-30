/**
 * Anthropic Authentication
 *
 * 5-tier auth resolution:
 *   1. ANTHROPIC_SEARCH_API_KEY / ANTHROPIC_SEARCH_BASE_URL env vars
 *   2. ANTHROPIC_FOUNDRY_API_KEY override when Foundry mode is enabled
 *   3. OAuth credentials in ~/.omp/agent/agent.db (with expiry check)
 *   4. API key credentials in ~/.omp/agent/agent.db
 *   5. Generic Anthropic fallback (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL)
 */
import { $env, getAgentDbPath } from "@oh-my-pi/pi-utils";
import { type AuthCredential, AuthCredentialStore } from "../auth-storage";
import {
	buildAnthropicHeaders as buildProviderAnthropicHeaders,
	normalizeAnthropicBaseUrl,
} from "../providers/anthropic";
import { getEnvApiKey } from "../stream";
import { isFoundryEnabled } from "./foundry";

/** Auth configuration for Anthropic */
export interface AnthropicAuthConfig {
	apiKey: string;
	baseUrl: string;
	isOAuth: boolean;
}

/** OAuth credential for Anthropic API access */
export interface AnthropicOAuthCredential {
	type: "oauth";
	access: string;
	refresh?: string;
	/** Expiry timestamp in milliseconds */
	expires: number;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
	const trimmed = baseUrl?.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}
function resolveAnthropicBaseUrlFromEnv(): string | undefined {
	if (isFoundryEnabled()) {
		const foundryBaseUrl = normalizeBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) return foundryBaseUrl;
	}
	const anthropicBaseUrl = normalizeBaseUrl($env.ANTHROPIC_BASE_URL);
	return anthropicBaseUrl || undefined;
}

/**
 * Checks if a token is an OAuth token by looking for sk-ant-oat prefix.
 * @param apiKey - The API key to check
 * @returns True if the token is an OAuth token
 */
export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

/**
 * Converts a generic AuthCredential to AnthropicOAuthCredential if it's a valid OAuth entry.
 * @param credential - The credential to convert
 * @returns The converted OAuth credential, or null if not a valid OAuth type
 */
function toAnthropicOAuthCredential(credential: AuthCredential): AnthropicOAuthCredential | null {
	if (credential.type !== "oauth") return null;
	if (typeof credential.access !== "string" || typeof credential.expires !== "number") return null;
	return {
		type: "oauth",
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
	};
}

/**
 * Reads Anthropic OAuth credentials from an AuthCredentialStore.
 * @param store - Credential store to read from (creates AuthCredentialStore if not provided)
 * @returns Array of valid Anthropic OAuth credentials
 */
async function readAnthropicOAuthCredentials(store?: AuthCredentialStore): Promise<AnthropicOAuthCredential[]> {
	const ownsStore = !store;
	const effectiveStore = store ?? (await AuthCredentialStore.open(getAgentDbPath()));
	try {
		const records = effectiveStore.listAuthCredentials("anthropic");
		const credentials: AnthropicOAuthCredential[] = [];
		for (const record of records) {
			const mapped = toAnthropicOAuthCredential(record.credential);
			if (mapped) {
				credentials.push(mapped);
			}
		}

		return credentials;
	} finally {
		if (ownsStore) {
			effectiveStore.close();
		}
	}
}

/**
 * Finds Anthropic auth config using priority:
 *   1. ANTHROPIC_SEARCH_API_KEY / ANTHROPIC_SEARCH_BASE_URL
 *   2. ANTHROPIC_FOUNDRY_API_KEY override when Foundry mode is enabled
 *   3. OAuth in agent.db (with 5-minute expiry buffer)
 *   4. API key in agent.db
 *   5. ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL fallback
 * @param store - Optional credential store (creates one from default db path if not provided)
 * @returns The first valid auth configuration found, or null if none available
 */
export async function findAnthropicAuth(store?: AuthCredentialStore): Promise<AnthropicAuthConfig | null> {
	// 1. Explicit search-specific env vars
	const searchApiKey = $env.ANTHROPIC_SEARCH_API_KEY;
	const searchBaseUrl = $env.ANTHROPIC_SEARCH_BASE_URL;
	if (searchApiKey) {
		return {
			apiKey: searchApiKey,
			baseUrl: searchBaseUrl ?? DEFAULT_BASE_URL,
			isOAuth: isOAuthToken(searchApiKey),
		};
	}

	// 2. Foundry explicit env override
	const foundryApiKey = isFoundryEnabled() ? $env.ANTHROPIC_FOUNDRY_API_KEY?.trim() : undefined;
	if (foundryApiKey) {
		return {
			apiKey: foundryApiKey,
			baseUrl: resolveAnthropicBaseUrlFromEnv() ?? DEFAULT_BASE_URL,
			isOAuth: isOAuthToken(foundryApiKey),
		};
	}

	// Tiers 3-4 use the credential store; manage lifecycle once
	const ownsStore = !store;
	const effectiveStore = store ?? (await AuthCredentialStore.open(getAgentDbPath()));
	try {
		// 3. OAuth credentials in agent.db (with 5-minute expiry buffer)
		const expiryBuffer = 5 * 60 * 1000; // 5 minutes
		const now = Date.now();
		const credentials = await readAnthropicOAuthCredentials(effectiveStore);
		for (const credential of credentials) {
			if (!credential.access) continue;
			if (credential.expires > now + expiryBuffer) {
				return {
					apiKey: credential.access,
					baseUrl: DEFAULT_BASE_URL,
					isOAuth: true,
				};
			}
		}

		// 4. API key credentials in agent.db
		const storedApiKey = effectiveStore.getApiKey("anthropic");
		if (storedApiKey) {
			return {
				apiKey: storedApiKey,
				baseUrl: resolveAnthropicBaseUrlFromEnv() ?? DEFAULT_BASE_URL,
				isOAuth: isOAuthToken(storedApiKey),
			};
		}
	} finally {
		if (ownsStore) {
			effectiveStore.close();
		}
	}

	// 5. Generic ANTHROPIC_API_KEY fallback
	const apiKey = getEnvApiKey("anthropic");
	const baseUrl = resolveAnthropicBaseUrlFromEnv();
	if (apiKey) {
		return {
			apiKey,
			baseUrl: baseUrl ?? DEFAULT_BASE_URL,
			isOAuth: isOAuthToken(apiKey),
		};
	}

	return null;
}

/**
 * Builds HTTP headers for Anthropic API requests (search variant).
 * @param auth - The authentication configuration
 * @returns Headers object ready for use in fetch requests
 */
export function buildAnthropicSearchHeaders(auth: AnthropicAuthConfig): Record<string, string> {
	return buildProviderAnthropicHeaders({
		apiKey: auth.apiKey,
		baseUrl: auth.baseUrl,
		isOAuth: auth.isOAuth,
		extraBetas: ["web-search-2025-03-05"],
		stream: false,
	});
}

/**
 * Builds the full API URL for Anthropic messages endpoint.
 * @param auth - The authentication configuration
 * @returns The complete API URL with beta query parameter
 */
export function buildAnthropicUrl(auth: AnthropicAuthConfig): string {
	const normalizedBaseUrl = normalizeAnthropicBaseUrl(auth.baseUrl);
	const base = `${normalizedBaseUrl}/v1/messages`;
	return `${base}?beta=true`;
}
