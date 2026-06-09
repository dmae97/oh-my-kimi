import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { isUsageLimitError } from "./rate-limit-utils";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * The `error`/`lastChance` pair drives the central a/b/c retry policy shared by
 * the streaming ({@link streamSimple}) and non-streaming ({@link withAuth})
 * drivers:
 * - `error === undefined` → **initial resolve** (no force-refresh; cheap, may
 *   return a locally-cached not-yet-expired token).
 * - `error !== undefined && !lastChance` → **step (b): refresh the SAME
 *   account** (force a token re-mint / await an in-flight broker refresh).
 * - `error !== undefined && lastChance` → **step (c): switch account**
 *   (invalidate/usage-limit the current credential and rotate to a sibling).
 *
 * The resolver returns the bearer to send, or `undefined` to stop retrying and
 * surface the last error to the caller.
 */
export interface ApiKeyResolveContext {
	/** True on the final retry step — the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 */
export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) return (await key({ lastChance: false, error: undefined, signal })) || undefined;
	return key;
}

/**
 * Classifies whether an error should trigger a credential refresh/rotation
 * retry: a hard `401`, or a rotatable usage-limit ("usage_limit_reached",
 * Codex's "you have hit your ChatGPT usage limit", etc.).
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) === 401) return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (!message) return false;
	if (extractHttpStatusFromError({ message }) === 401) return true;
	return isUsageLimitError(message);
}

/**
 * The ordered `lastChance` values for the retry steps after the initial
 * attempt fails: `false` → step (b) refresh-same, `true` → step (c) switch.
 * Shared by {@link withAuth} and the streaming retry driver so both run the
 * same policy.
 */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

/** Resolve a single retry step, swallowing resolver failures into `undefined`. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		return (await resolver({ lastChance, error, signal })) || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runs an auth-protected operation through the central a/b/c retry policy.
 *
 * - A static string key (or any non-resolver) → a single `attempt` with no
 *   retry (identical to the legacy static-key path).
 * - A resolver → initial `attempt`, then on a retryable auth error up to two
 *   more attempts (refresh-same, then switch). A step is skipped when the
 *   resolver returns the same key it just tried or `undefined`; non-auth errors
 *   propagate immediately.
 *
 * Used by non-streaming consumers (image generation, web search, completion
 * helpers). The streaming driver in `stream.ts` implements the same policy with
 * its replay-safe buffering machinery.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new Error(opts?.missingKeyMessage ?? "No API key available");

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const signal = opts?.signal;
	let lastKey = await resolveRetryKey(resolver, false, undefined, signal);
	if (lastKey === undefined) throw missingKey();

	let lastError: unknown;
	try {
		return await attempt(lastKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	for (let i = 0; i < AUTH_RETRY_STEPS.length; i++) {
		const nextKey = await resolveRetryKey(resolver, AUTH_RETRY_STEPS[i]!, lastError, signal);
		if (nextKey === undefined || nextKey === lastKey) continue;
		lastKey = nextKey;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}
