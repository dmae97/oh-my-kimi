import { isRetryableError, isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils";
import {
	isRetryableStreamEnvelopeError,
	isTransientStreamParseError,
	isUsageLimit,
	status,
	TRANSIENT_TRANSPORT_PATTERN,
} from "./flags";

// Provider-stream transient phrasings not covered by the shared
// TRANSIENT_TRANSPORT_PATTERN (TLS record corruption, HTTP/2 peer stream
// errors, upstream code 1302). The shared pattern already covers rate-limit /
// overloaded / 5xx / timeout / first-event wording.
const PROVIDER_TRANSIENT_EXTRA_PATTERN = /bad record mac|stream error.*received from peer|1302/i;

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
		TRANSIENT_TRANSPORT_PATTERN.test(msg) ||
		PROVIDER_TRANSIENT_EXTRA_PATTERN.test(msg) ||
		isTransientStreamParseError(error) ||
		isRetryableStreamEnvelopeError(error)
	) {
		return true;
	}
	return isRetryableError(error);
}
