/**
 * Wafer login flows.
 *
 * Wafer (https://wafer.ai) exposes a single OpenAI-compatible base URL
 * (`https://pass.wafer.ai/v1`) for two SKUs:
 *
 *  - **Wafer Pass** — flat-rate subscription. The key authorizes models whose
 *    catalog entries carry `wafer.tier = "pass_included"`.
 *  - **Wafer Serverless** — pay-as-you-go. Superset of Pass; the same `/v1/models`
 *    endpoint returns the full per-account model list.
 *
 * Both SKUs issue `wfr_…` keys. The key prefix alone does not distinguish
 * tiers — the entitlement is per-account on the server side — so we expose
 * two parallel logins / env vars (`WAFER_PASS_API_KEY`, `WAFER_SERVERLESS_API_KEY`)
 * mirroring the firepass/fireworks split, letting users with both
 * subscriptions switch between them without re-pasting.
 *
 * Validation uses the shared `/v1/models` endpoint, which works for both
 * tiers and is cheap (no token spend).
 */
import { createApiKeyLogin } from "./api-key-login";

const WAFER_AUTH_URL = "https://wafer.ai/dashboard";
const WAFER_MODELS_URL = "https://pass.wafer.ai/v1/models";

export const loginWaferPass = createApiKeyLogin({
	providerLabel: "Wafer Pass",
	authUrl: WAFER_AUTH_URL,
	instructions: "Create or copy your Wafer Pass API key from the Wafer dashboard",
	promptMessage: "Paste your Wafer Pass API key",
	placeholder: "wfr_...",
	validation: {
		kind: "models-endpoint",
		provider: "Wafer Pass",
		modelsUrl: WAFER_MODELS_URL,
	},
});

export const loginWaferServerless = createApiKeyLogin({
	providerLabel: "Wafer Serverless",
	authUrl: WAFER_AUTH_URL,
	instructions: "Create or copy your Wafer Serverless API key from the Wafer dashboard",
	promptMessage: "Paste your Wafer Serverless API key",
	placeholder: "wfr_...",
	validation: {
		kind: "models-endpoint",
		provider: "Wafer Serverless",
		modelsUrl: WAFER_MODELS_URL,
	},
});
