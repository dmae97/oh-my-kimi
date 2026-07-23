/**
 * Perplexity login (email OTP flow).
 *
 * Uses Perplexity's HTTP API for email-based one-time-password authentication.
 * No browser or manual cookie paste required.
 *
 * The Perplexity JWT tokens are long-lived (server-side sessions) and generally
 * do not expire from the client's perspective.
 */
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const API_VERSION = "2.18";
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

export const PERPLEXITY_OAUTH_PROVIDER_ID = "perplexity";

const NEVER_EXPIRES = 8.64e15; // max safe Date value

function getJwtExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return NEVER_EXPIRES;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (typeof decoded?.exp === "number" && Number.isFinite(decoded.exp)) {
			return decoded.exp * 1000 - 5 * 60_000;
		}
	} catch {
		// Ignore decode errors
	}
	return NEVER_EXPIRES;
}

function jwtToCredentials(jwt: string, email?: string): OAuthCredentials {
	return {
		access: jwt,
		refresh: jwt,
		expires: getJwtExpiry(jwt),
		email,
	};
}

/** Log in to Perplexity using email OTP. */
export async function loginPerplexity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (!callbacks.onPrompt) {
		throw new Error("Perplexity login requires interactive prompt support");
	}

	const email = await callbacks.onPrompt({
		message: "Enter your Perplexity email address",
		placeholder: "user@example.com",
	});
	const trimmedEmail = email.trim();
	if (!trimmedEmail) throw new Error("Email is required for Perplexity login");
	if (callbacks.signal?.aborted) throw new Error("Login cancelled");

	callbacks.onProgress?.("Fetching Perplexity CSRF token...");
	const csrfResponse = await fetch("https://www.perplexity.ai/api/auth/csrf", {
		headers: {
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		signal: callbacks.signal,
	});

	if (!csrfResponse.ok) {
		throw new Error(`Perplexity CSRF request failed: ${csrfResponse.status}`);
	}

	const csrfData = (await csrfResponse.json()) as { csrfToken?: string };
	if (!csrfData.csrfToken) {
		throw new Error("Perplexity CSRF response missing csrfToken");
	}

	callbacks.onProgress?.("Sending login code to your email...");
	const sendResponse = await fetch("https://www.perplexity.ai/api/auth/signin-email", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			csrfToken: csrfData.csrfToken,
		}),
		signal: callbacks.signal,
	});

	if (!sendResponse.ok) {
		const body = await sendResponse.text();
		throw new Error(`Perplexity send login code failed (${sendResponse.status}): ${body}`);
	}

	const otp = await callbacks.onPrompt({
		message: "Enter the code sent to your email",
		placeholder: "123456",
	});
	const trimmedOtp = otp.trim();
	if (!trimmedOtp) throw new Error("OTP code is required");
	if (callbacks.signal?.aborted) throw new Error("Login cancelled");

	callbacks.onProgress?.("Verifying login code...");
	const verifyResponse = await fetch("https://www.perplexity.ai/api/auth/signin-otp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": APP_USER_AGENT,
			"X-App-ApiVersion": API_VERSION,
		},
		body: JSON.stringify({
			email: trimmedEmail,
			otp: trimmedOtp,
			csrfToken: csrfData.csrfToken,
		}),
		signal: callbacks.signal,
	});

	const verifyData = (await verifyResponse.json()) as {
		token?: string;
		status?: string;
		error_code?: string;
		text?: string;
	};

	if (!verifyResponse.ok) {
		const reason = verifyData.text ?? verifyData.error_code ?? verifyData.status ?? "OTP verification failed";
		throw new Error(`Perplexity OTP verification failed: ${reason}`);
	}

	if (!verifyData.token) {
		throw new Error("Perplexity OTP verification response missing token");
	}

	return jwtToCredentials(verifyData.token, trimmedEmail);
}

export const perplexityOAuthProvider: OAuthProviderInterface = {
	id: PERPLEXITY_OAUTH_PROVIDER_ID,
	name: "Perplexity (Pro/Max)",
	login: loginPerplexity,
	// Perplexity JWTs are long-lived; no refresh endpoint needed
	refreshToken: (credentials: OAuthCredentials) => Promise.resolve(credentials),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
