/**
 * Xiaomi MiMo login flow.
 *
 * Xiaomi MiMo provides OpenAI-compatible models via
 * https://api.xiaomimimo.com/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to Xiaomi MiMo API key console
 * 2. User copies their API key
 * 3. User pastes the API key into the CLI
 */

import type { OAuthController } from "./types";

const PROVIDER_ID = "xiaomi";
const PROVIDER_NAME = "Xiaomi MiMo";
const STANDARD_AUTH_URL = "https://platform.xiaomimimo.com/#/console/api-keys";
const STANDARD_API_BASE_URL = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN_SGP_API_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";
const TOKEN_PLAN_AMS_API_BASE_URL = "https://token-plan-ams.xiaomimimo.com/v1";
const TOKEN_PLAN_CN_API_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const TOKEN_PLAN_KEY_PREFIX = "tp-";
const STANDARD_VALIDATION_MODEL = "mimo-v2-flash";
const TOKEN_PLAN_VALIDATION_MODEL = "mimo-v2.5";

function isTokenPlanKey(apiKey: string): boolean {
	return apiKey.startsWith(TOKEN_PLAN_KEY_PREFIX);
}

const VALIDATION_TIMEOUT_MS = 15_000;

async function validateXiaomiApiKey(apiKey: string, signal?: AbortSignal): Promise<void> {
	// For token-plan keys try SGP → AMS → CN in order until one succeeds.
	// Standard sk- keys only hit the one endpoint.
	const endpoints = isTokenPlanKey(apiKey)
		? [
				{ baseUrl: TOKEN_PLAN_SGP_API_BASE_URL, model: TOKEN_PLAN_VALIDATION_MODEL },
				{ baseUrl: TOKEN_PLAN_AMS_API_BASE_URL, model: TOKEN_PLAN_VALIDATION_MODEL },
				{ baseUrl: TOKEN_PLAN_CN_API_BASE_URL, model: TOKEN_PLAN_VALIDATION_MODEL },
			]
		: [{ baseUrl: STANDARD_API_BASE_URL, model: STANDARD_VALIDATION_MODEL }];

	let lastError: Error | null = null;

	for (const ep of endpoints) {
		// Fresh timeout per endpoint so SGP→AMS fallback works after a regional
		// timeout: a shared AbortSignal.timeout would stay aborted and instantly
		// abort the AMS fetch.
		const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const response = await fetch(`${ep.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: ep.model,
					max_tokens: 1,
					messages: [{ role: "user", content: "ping" }],
				}),
				signal: requestSignal,
			});

			if (response.ok) {
				return;
			}

			// 401 means this endpoint didn't accept the key; try the next one
			if (response.status === 401) {
				let details = "";
				try {
					details = (await response.text()).trim();
				} catch {
					// ignore body parse errors, status is enough
				}
				lastError = new Error(
					details
						? `${PROVIDER_NAME} API key validation failed (${response.status}): ${details}`
						: `${PROVIDER_NAME} API key validation failed (${response.status})`,
				);
				continue;
			}

			// Non-auth errors are real failures
			let details = "";
			try {
				details = (await response.text()).trim();
			} catch {
				// ignore body parse errors, status is enough
			}
			const message = details
				? `${PROVIDER_NAME} API key validation failed (${response.status}): ${details}`
				: `${PROVIDER_NAME} API key validation failed (${response.status})`;
			throw new Error(message);
		} catch (e) {
			// Only re-throw AbortError when the caller explicitly cancelled.
			// Timeout aborts (from AbortSignal.timeout) should fall through to
			// the next endpoint so SGP→AMS fallback works during regional outages.
			if (e instanceof DOMException && e.name === "AbortError" && signal?.aborted) {
				throw e;
			}
			lastError = e instanceof Error ? e : new Error(String(e));
		}
	}
	throw lastError ?? new Error(`${PROVIDER_NAME} API key validation failed`);
}

/**
 * Login to Xiaomi MiMo.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginXiaomi(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_NAME} login requires onPrompt callback`);
	}
	options.onAuth?.({
		url: STANDARD_AUTH_URL,
		instructions: "Copy your API key from the Xiaomi MiMo console",
	});
	const apiKey = await options.onPrompt({
		message: "Paste your Xiaomi API key (sk-... or token-plan tp-...)",
		placeholder: "sk-... or tp-...",
	});
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.(`Validating ${PROVIDER_ID} API key...`);
	await validateXiaomiApiKey(trimmed, options.signal);
	return trimmed;
}
