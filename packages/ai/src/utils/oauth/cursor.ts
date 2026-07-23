/**
 * Cursor OAuth flow (Cursor AI IDE subscription).
 *
 * Uses PKCE + polling-based authentication.
 * After login, provides access to Claude, GPT, and other models through Cursor's API.
 */
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

export const CURSOR_OAUTH_PROVIDER_ID = "cursor";

interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();

	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});

	const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

	return { verifier, challenge, uuid, loginUrl };
}

async function pollCursorAuth(
	uuid: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error("Login cancelled");
		await sleep(delay);

		try {
			const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);

			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
				continue;
			}

			if (response.ok) {
				const data = (await response.json()) as {
					accessToken: string;
					refreshToken: string;
				};
				return {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
				};
			}

			throw new Error(`Poll failed: ${response.status}`);
		} catch (error) {
			if (signal?.aborted) throw new Error("Login cancelled");
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				throw new Error(
					`Too many consecutive errors during Cursor auth polling: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	throw new Error("Cursor authentication polling timeout");
}

function getTokenExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) {
			return Date.now() + 3600 * 1000;
		}
		const payload = parts[1];
		if (!payload) {
			return Date.now() + 3600 * 1000;
		}
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
			return decoded.exp * 1000 - 5 * 60 * 1000;
		}
	} catch {
		// Ignore parsing errors
	}
	return Date.now() + 3600 * 1000;
}

export function isCursorTokenExpiringSoon(token: string, thresholdSeconds = 300): boolean {
	try {
		const [, payload] = token.split(".");
		if (!payload) return true;
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		const currentTime = Math.floor(Date.now() / 1000);
		return decoded.exp - currentTime < thresholdSeconds;
	} catch {
		return true;
	}
}

/** Log in to Cursor using PKCE + polling. */
export async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

	callbacks.onAuth({ url: loginUrl, instructions: "Open the link in your browser to authenticate with Cursor" });
	callbacks.onProgress?.("Waiting for browser authentication...");

	const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier, callbacks.signal);

	const expiresAt = getTokenExpiry(accessToken);

	return {
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt,
	};
}

/** Refresh a Cursor access token. */
export async function refreshCursorToken(apiKeyOrRefreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKeyOrRefreshToken}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Cursor token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		accessToken: string;
		refreshToken: string;
	};

	const expiresAt = getTokenExpiry(data.accessToken);

	return {
		access: data.accessToken,
		refresh: data.refreshToken || apiKeyOrRefreshToken,
		expires: expiresAt,
	};
}

export const cursorOAuthProvider: OAuthProviderInterface = {
	id: CURSOR_OAUTH_PROVIDER_ID,
	name: "Cursor (Claude, GPT, etc.)",
	login: loginCursor,
	refreshToken: (credentials: OAuthCredentials) => refreshCursorToken(credentials.refresh),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
