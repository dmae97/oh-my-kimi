/**
 * GitHub Copilot OAuth flow (opencode OAuth app)
 */
import { abortableSleep } from "@oh-my-pi/pi-utils";
import { getBundledModels } from "../../models";
import type { OAuthCredentials } from "./types";

const CLIENT_ID = "Ov23li8tweQw6odWQebz";

export const COPILOT_USER_AGENT = "opencode/1.3.15" as const;

export const OPENCODE_HEADERS = {
	"User-Agent": COPILOT_USER_AGENT,
} as const;

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;
type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

type GitHubCopilotApiKeyPayload = {
	token?: unknown;
	enterpriseUrl?: unknown;
};

export type ParsedGitHubCopilotApiKey = {
	accessToken: string;
	enterpriseUrl?: string;
};

const PUBLIC_GITHUB_HOSTS = new Set(["api.github.com", "github.com", "www.github.com"]);

function isPublicGitHubHost(host: string): boolean {
	return PUBLIC_GITHUB_HOSTS.has(host.trim().toLowerCase());
}

export function normalizeGitHubCopilotEnterpriseDomain(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	const normalized = normalizeDomain(trimmed) ?? trimmed.toLowerCase();
	if (!normalized || isPublicGitHubHost(normalized)) return undefined;
	return normalized;
}

export function parseGitHubCopilotApiKey(apiKeyRaw: string): ParsedGitHubCopilotApiKey {
	try {
		const parsed = JSON.parse(apiKeyRaw) as GitHubCopilotApiKeyPayload;
		if (typeof parsed.token === "string") {
			return {
				accessToken: parsed.token,
				enterpriseUrl:
					typeof parsed.enterpriseUrl === "string"
						? normalizeGitHubCopilotEnterpriseDomain(parsed.enterpriseUrl)
						: undefined,
			};
		}
	} catch {}

	return { accessToken: apiKeyRaw };
}

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	};
}

export function getGitHubCopilotBaseUrl(enterpriseDomain?: string): string {
	const normalizedEnterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(enterpriseDomain);
	if (!normalizedEnterpriseDomain) return "https://api.githubcopilot.com";
	const host = normalizedEnterpriseDomain.startsWith("copilot-api.")
		? normalizedEnterpriseDomain
		: `copilot-api.${normalizedEnterpriseDomain}`;
	return `https://${host}`;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			...OPENCODE_HEADERS,
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

async function sleepForGitHubAccessTokenPoll(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await abortableSleep(ms, signal);
	} catch {
		throw new Error("Login cancelled");
	}
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		await sleepForGitHubAccessTokenPoll(waitMs, signal);

		const raw = await fetchJson(urls.accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				...OPENCODE_HEADERS,
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return (raw as DeviceTokenSuccessResponse).access_token;
		}

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0 ? interval * 1000 : Math.max(1000, intervalMs + 5000);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
		}
	}

	if (slowDownResponses > 0) {
		throw new Error(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
		);
	}

	throw new Error("Device flow timed out");
}

/** Far-future expiry (10 years). GitHub OAuth tokens are long-lived; no JWT exchange needed. */
const FAR_FUTURE_MS = Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Refresh GitHub Copilot token.
 * With the opencode OAuth flow, the GitHub token is used directly — no JWT exchange needed.
 */
export function refreshGitHubCopilotToken(refreshToken: string, enterpriseDomain?: string): OAuthCredentials {
	return {
		refresh: refreshToken,
		access: refreshToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain,
	};
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
async function enableGitHubCopilotModel(token: string, modelId: string, enterpriseDomain?: string): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...OPENCODE_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 */
async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain?: string,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
	const models = getBundledModels("github-copilot");
	const BATCH_SIZE = 5;
	for (let i = 0; i < models.length; i += BATCH_SIZE) {
		const batch = models.slice(i, i + BATCH_SIZE);
		await Promise.all(
			batch.map(async model => {
				const success = await enableGitHubCopilotModel(token, model.id, enterpriseDomain);
				onProgress?.(model.id, success);
			}),
		);
	}
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 */
export async function loginGitHubCopilot(options: {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = input.trim();
	const normalizedDomain = normalizeDomain(input);
	if (trimmed && !normalizedDomain) {
		throw new Error("Invalid GitHub Enterprise URL/domain");
	}
	const enterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(normalizedDomain ?? undefined);
	const domain =
		normalizedDomain && isPublicGitHubHost(normalizedDomain) ? "github.com" : (normalizedDomain ?? "github.com");

	const device = await startDeviceFlow(domain);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
	);

	// With opencode OAuth, the GitHub token is used directly for all API requests
	const credentials: OAuthCredentials = {
		refresh: githubAccessToken,
		access: githubAccessToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain ?? undefined,
	};

	// Enable all models after successful login
	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(githubAccessToken, enterpriseDomain ?? undefined);
	return credentials;
}
