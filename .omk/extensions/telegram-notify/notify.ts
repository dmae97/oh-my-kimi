/**
 * Decision and payload core for the Telegram completion notifier.
 *
 * Kept free of I/O so the parts that matter — what gets sent, and whether
 * anything gets sent at all — are testable without a network or a bot token.
 */

export type Outcome = "completed" | "failed" | "aborted";

export interface NotifyConfig {
	readonly token: string;
	readonly chatId: string;
	/** Successful runs shorter than this are not worth a phone buzz. */
	readonly minDurationMs: number;
	readonly onSuccess: boolean;
	readonly onFailure: boolean;
	readonly onAbort: boolean;
}

const DEFAULT_MIN_DURATION_MS = 5000;

/** The only host this extension may ever contact. */
export const TELEGRAM_ORIGIN = "https://api.telegram.org";

/**
 * Telegram bot tokens are `<bot id>:<secret>`.
 *
 * The token becomes a path segment, so an unvalidated one is attacker-controlled
 * URL structure. `..` segments normalize away and cannot move the request off
 * `api.telegram.org`, but pinning the shape means a malformed value fails where
 * it was set rather than producing a request to some other path on the host.
 */
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

function readFlag(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Read configuration from the environment, or return null to stay inert.
 *
 * Credentials are never read from a file in the repository: a bot token in a
 * committed config is a token in everyone's checkout. Missing credentials are
 * the normal case for anyone who has not set this up, so they disable the
 * extension rather than failing the run.
 */
export function resolveConfig(env: Record<string, string | undefined>): NotifyConfig | null {
	if (!readFlag(env.OMK_TELEGRAM_NOTIFY, true)) return null;

	const token = env.TELEGRAM_BOT_TOKEN?.trim();
	const chatId = env.TELEGRAM_CHAT_ID?.trim();
	if (!token || !chatId) return null;

	// Setting a token is deliberate, so a malformed one is a mistake worth
	// reporting rather than silently disabling. The value is never echoed.
	if (!TOKEN_PATTERN.test(token)) {
		throw new Error("TELEGRAM_BOT_TOKEN is not a Telegram bot token (expected <bot id>:<secret>)");
	}

	const rawFloor = env.OMK_TELEGRAM_MIN_DURATION_MS;
	let minDurationMs = DEFAULT_MIN_DURATION_MS;
	if (rawFloor !== undefined) {
		const parsed = Number(rawFloor);
		// A typo must not silently become "notify on everything".
		if (!Number.isFinite(parsed) || parsed < 0) {
			throw new Error(`OMK_TELEGRAM_MIN_DURATION_MS must be a non-negative number, got ${JSON.stringify(rawFloor)}`);
		}
		minDurationMs = parsed;
	}

	return {
		token,
		chatId,
		minDurationMs,
		onSuccess: readFlag(env.OMK_TELEGRAM_ON_SUCCESS, true),
		onFailure: readFlag(env.OMK_TELEGRAM_ON_FAILURE, true),
		onAbort: readFlag(env.OMK_TELEGRAM_ON_ABORT, true),
	};
}

/**
 * Classify the run from the last assistant message.
 *
 * The last one decides: a run that failed a provider call, retried, and then
 * finished is a success, and reporting the earlier error would be wrong.
 */
export function deriveOutcome(messages: readonly unknown[]): Outcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: unknown; stopReason?: unknown } | null;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason === "error") return "failed";
		if (message.stopReason === "aborted") return "aborted";
		return "completed";
	}
	// No assistant message at all is not evidence of failure.
	return "completed";
}

/** Whether this outcome, at this duration, is worth sending. */
export function shouldNotify(input: {
	readonly config: NotifyConfig;
	readonly outcome: Outcome;
	readonly durationMs: number;
}): boolean {
	const { config, outcome, durationMs } = input;
	switch (outcome) {
		// The floor applies only to success. A run that failed after one second
		// is exactly the one worth interrupting someone for.
		case "completed":
			return config.onSuccess && durationMs >= config.minDurationMs;
		case "failed":
			return config.onFailure;
		case "aborted":
			return config.onAbort;
	}
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const OUTCOME_TEXT: Record<Outcome, string> = {
	completed: "completed",
	failed: "failed",
	aborted: "stopped",
};

/**
 * Build the notification text.
 *
 * Deliberately not given the messages. A bot chat is not a private channel and a
 * transcript carries source, file paths, and whatever was pasted into the
 * session; "it is done" needs none of it, so there is nothing here to leak.
 */
export function buildMessage(input: {
	readonly outcome: Outcome;
	readonly durationMs: number;
	readonly label?: string;
}): string {
	const scope = input.label ? `${input.label}: ` : "";
	return `OMK ${scope}${OUTCOME_TEXT[input.outcome]} after ${formatDuration(input.durationMs)}`;
}

/**
 * Telegram authenticates by path segment, so the token belongs in the URL and
 * nowhere else. The origin is asserted after construction: this is the one
 * outbound request the extension makes, and it may only ever go to Telegram.
 */
export function telegramApiUrl(token: string): string {
	if (!TOKEN_PATTERN.test(token)) {
		throw new Error("refusing to build a Telegram URL from a malformed token");
	}
	const url = new URL(`/bot${token}/sendMessage`, TELEGRAM_ORIGIN);
	if (url.origin !== TELEGRAM_ORIGIN) {
		throw new Error(`refusing to send outside ${TELEGRAM_ORIGIN}`);
	}
	return url.toString();
}
