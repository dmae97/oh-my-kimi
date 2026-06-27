import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";

/**
 * Resolve the base URL for ChatGPT account-API requests (`wham/usage`,
 * `wham/rate-limit-reset-credits`).
 *
 * These endpoints live on the canonical ChatGPT origin and authenticate with
 * the Codex OAuth bearer minted for that origin. They are NOT part of the
 * `/responses` API surface that streaming proxies (Headroom, 9router, etc.)
 * forward, so a `providers.openai-codex.baseUrl` override pointed at such a
 * proxy MUST NOT be used here — doing so 404s and silently breaks
 * `/usage show` (issue #3679).
 *
 * Accepted overrides are the canonical `chatgpt.com` / `chat.openai.com`
 * origins (optionally without `/backend-api`, which is appended). Any other
 * host falls back to {@link CODEX_BASE_URL}.
 */
export function normalizeCodexBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return CODEX_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return CODEX_BASE_URL;
	}
	const host = parsed.host.toLowerCase();
	if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_BASE_URL;
	const lower = trimmed.toLowerCase();
	if (!lower.includes("/backend-api")) return `${parsed.origin}/backend-api`;
	return trimmed;
}
