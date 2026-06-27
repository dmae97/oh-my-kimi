import { isRetryableError, isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils";
import { isRetryableStreamEnvelopeError, isTransientStreamParseError, isUsageLimit, status } from "./flags";

const PROVIDER_TRANSIENT_PATTERN =
	/rate.?limit|too many requests|overloaded|service.?unavailable|internal_error|server_error|bad record mac|stream error.*received from peer|1302|timed?\s*out while waiting for the first event|timeout waiting for first/i;

function isTransientTransportMessage(message: string): boolean {
	return message.includes("tls: bad record mac") || message.includes("type=server_error");
}

/** Hook for provider-specific transient detection that the error module must not import directly. */
export interface ProviderRetryableHooks {
	/** Provider id of the failing request, used to gate provider-specific checks. */
	provider?: string;
	/** Provider-specific transient predicate (e.g. Copilot `model_not_supported`). */
	isProviderTransient?: (error: Error) => boolean;
}

/**
 * Whether a provider stream error should be retried against the same credential.
 *
 * Account-level usage/quota limits are deliberately treated as **non**-retryable
 * here — they are owned by the credential-rotation layer (auth-gateway /
 * `streamSimple` a/b/c policy), not this seconds-scale provider backoff.
 *
 * Provider-specific transient cases are injected via {@link ProviderRetryableHooks}
 * so this stays free of provider imports.
 */
export function isProviderRetryableError(error: unknown, hooks: ProviderRetryableHooks = {}): boolean {
	if (!(error instanceof Error)) return false;
	if (hooks.isProviderTransient?.(error)) return true;
	if (isUsageLimit(error)) return false;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
		return false;
	}
	const msg = error.message.toLowerCase();
	if (
		isUnexpectedSocketCloseMessage(msg) ||
		isTransientTransportMessage(msg) ||
		PROVIDER_TRANSIENT_PATTERN.test(msg) ||
		isTransientStreamParseError(error) ||
		isRetryableStreamEnvelopeError(error)
	) {
		return true;
	}
	return isRetryableError(error);
}
