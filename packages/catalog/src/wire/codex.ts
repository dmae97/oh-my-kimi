/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend
 */

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
	SCOPED_SESSION_ID: "session-id",
	THREAD_ID: "thread-id",
	INSTALLATION_ID: "x-codex-installation-id",
	WINDOW_ID: "x-codex-window-id",
	TURN_METADATA: "x-codex-turn-metadata",
	PARENT_THREAD_ID: "x-codex-parent-thread-id",
	SUBAGENT: "x-openai-subagent",
	/** Responses Lite transport marker (codex-rs `add_responses_lite_header`); value is always `"true"`. */
	RESPONSES_LITE: "x-openai-internal-codex-responses-lite",
} as const;

export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06",
	ORIGINATOR_CODEX: "pi",
} as const;

export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/**
 * Extract account ID from a Codex JWT access token.
 * Returns undefined if the token is not a valid Codex JWT.
 */
export function getCodexAccountId(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf-8");
		const payload = JSON.parse(decoded) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
		return auth?.chatgpt_account_id ?? undefined;
	} catch {
		return undefined;
	}
}
