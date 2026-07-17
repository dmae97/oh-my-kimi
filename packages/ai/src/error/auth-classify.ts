import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { isOAuthExpiry, isUsageLimit } from "./flags";
import { isUsageLimitOutcome } from "./rate-limit";

/**
 * Whether an OAuth refresh failure is definitive (the credential must be
 * disabled) versus transient. Thin alias over the {@link Flag.OAuthExpiry}
 * text classifier {@link isOAuthExpiry}; retained as the public
 * `@oh-my-pi/pi-ai` entrypoint name used by the coding agent and auth-broker.
 */
export function isDefinitiveOAuthFailure(errorMsg: string): boolean {
	return isOAuthExpiry(errorMsg);
}

const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;

/** Whether an upstream response explicitly says the supplied OAuth bearer was invalidated. */
export function isInvalidatedOAuthTokenError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "errorMessage" in error) {
		const errorMessage = error.errorMessage;
		if (typeof errorMessage === "string" && INVALIDATED_OAUTH_TOKEN_PATTERN.test(errorMessage)) return true;
	}
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && INVALIDATED_OAUTH_TOKEN_PATTERN.test(message);
}

/**
 * Whether an upstream failure should rotate to a sibling credential: a hard
 * `401`, a body-classified usage limit (Codex `usage_limit_reached`, Anthropic
 * account rate-limit, Google `resource_exhausted`, OpenAI `insufficient_quota`,
 * …), or a bare `429` whose payload did not preserve a richer quota code.
 * Transient 429s (`Too many requests`, per-minute caps) stay in the
 * upstream-backoff lane.
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (isUsageLimit(error)) return true;
	if (isInvalidatedOAuthTokenError(error)) return true;
	const httpStatus = extractHttpStatusFromError(error);
	if (httpStatus === 401) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	const embeddedStatus = message ? extractHttpStatusFromError({ message }) : undefined;
	if (embeddedStatus === 401) return true;
	return isUsageLimitOutcome(httpStatus ?? embeddedStatus, message);
}
