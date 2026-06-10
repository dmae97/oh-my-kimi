import { scheduler } from "node:timers/promises";
import { extractHttpStatusFromError, isRetryableError } from "@oh-my-pi/pi-utils";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./retry-after";

/**
 * GitHub Copilot intermittently rejects preview models (gpt-5.3-codex,
 * gpt-5.4, gpt-5.4-mini, ...) with HTTP 400 `model_not_supported`, even
 * though the model is listed as enabled on the user's account via `/models`.
 *
 * Root cause: Copilot's request-routing backend is rolled out per OAuth
 * client. Our OAuth client id is shared with opencode; VS Code uses its own
 * client and sees full availability, so the same account may succeed in VS
 * Code and flap between 200/400 here. See opencode#13313 and copilot-cli#2597.
 *
 * Retrying the identical request 2-3 times almost always lands on a backend
 * that has the model, so we wrap the initial request with a short retry loop.
 */
export function isCopilotTransientModelError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	if (!error || typeof error !== "object") return false;
	const info = error as { code?: unknown; error?: { code?: unknown } | null };
	const code = typeof info.code === "string" ? info.code : info.error?.code;
	return code === "model_not_supported";
}

const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 3;
const COPILOT_MODEL_RETRY_BASE_DELAY_MS = 400;
/** Longest server-requested backoff we are willing to sit out before giving up. */
const COPILOT_RETRY_AFTER_MAX_WAIT_MS = 30_000;

/**
 * Wrap an initial Copilot request so transient `model_not_supported` 400s are
 * retried a small number of times. No-op for non-Copilot providers.
 *
 * The callback **MUST** create a fresh in-flight request each invocation — a
 * once-consumed AsyncIterable cannot be re-iterated.
 */
export async function callWithCopilotModelRetry<T>(
	fn: () => Promise<T>,
	options: { provider: string; signal?: AbortSignal; retryBaseDelayMs?: number },
): Promise<T> {
	if (options.provider !== "github-copilot") return fn();

	let lastError: unknown;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? COPILOT_MODEL_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; attempt < COPILOT_MODEL_RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			// A latched abort (caller cancel or local watchdog) makes any retry a
			// guaranteed-dead attempt — surface the original error, not the
			// scheduler's AbortError.
			if (options.signal?.aborted) throw error;
			const transientModelError = isCopilotTransientModelError(error);
			if (!transientModelError && !isRetryableError(error)) throw error;
			if (attempt === COPILOT_MODEL_RETRY_MAX_ATTEMPTS - 1) break;
			let delayMs = retryBaseDelayMs * (attempt + 1);
			if (!transientModelError) {
				const status = extractHttpStatusFromError(error);
				if (status !== undefined) {
					// Status-bearing retryable errors (429/5xx) are only re-sent when
					// the server told us when to come back — a blind fixed-delay retry
					// of a rate limit just burns the remaining attempts. Status-less
					// transport blips (socket close, h2 reset) keep the linear backoff.
					const retryAfterMs = getRetryAfterMsFromHeaders(getHeadersFromError(error));
					if (retryAfterMs === undefined || retryAfterMs > COPILOT_RETRY_AFTER_MAX_WAIT_MS) throw error;
					delayMs = Math.max(delayMs, retryAfterMs);
				}
			}
			await scheduler.wait(delayMs, { signal: options.signal });
		}
	}
	throw lastError;
}
