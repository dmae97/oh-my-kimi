import type { ApiKeyResolver, AuthStorage } from "@oh-my-pi/pi-ai";

export interface ApiKeyResolverOptions {
	/** Session id for credential stickiness; read at resolve time by the caller. */
	sessionId?: string;
	/** Provider base URL hint forwarded to the auth-storage cascade. */
	baseUrl?: string;
}

/**
 * Minimal slice of `ModelRegistry` the resolver needs. Typed structurally so
 * narrower registry shells (e.g. the commit pipeline's `CommitModelRegistry`)
 * can build resolvers without depending on the full class.
 */
export interface ApiKeyResolverRegistry {
	getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined>;
	authStorage: Pick<AuthStorage, "rotateSessionCredential">;
}

/**
 * Build an {@link ApiKeyResolver} backed by the model registry's auth storage,
 * implementing the central a/b/c auth-retry policy for every non-agent network
 * consumer (utility completions, image generation, web search):
 *
 * - initial (`error: undefined`) → resolve the session credential (cheap; may
 *   return a locally-cached not-yet-expired token).
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → rotate to a sibling credential (usage-limit block
 *   vs credential invalidation, by error class), then re-resolve.
 *
 * Stateless: nothing is captured beyond the registry/provider/options, so the
 * same resolver is safe to reuse across attempts and requests.
 */
export function createApiKeyResolver(
	registry: ApiKeyResolverRegistry,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl } = options;
	return async ({ lastChance, error, signal }) => {
		if (error === undefined) {
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl });
		}
		if (lastChance) {
			// Account constraint (401 / usage / account-rate-limit): rotate to a
			// sibling credential. We do NOT honor any retry-after here — if a
			// sibling exists we switch immediately; the precise no-sibling backoff
			// is owned by `markUsageLimitReached` (default + server usage-report
			// reset) and the outer whole-turn retry layer.
			await registry.authStorage.rotateSessionCredential(provider, sessionId, { error, signal });
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl });
		}
		return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, forceRefresh: true, signal });
	};
}

/**
 * Wrap an already-resolved `initialKey` in an {@link ApiKeyResolver}: the
 * initial step returns that key verbatim (so a caller that resolved it eagerly
 * — e.g. to preserve a metadata / guard ordering, or to short-circuit when no
 * credential exists — does not pay for a second resolve), while retry steps
 * fall through to {@link createApiKeyResolver}'s force-refresh / rotate policy.
 */
export function reuseInitialApiKey(
	initialKey: string | undefined,
	registry: ApiKeyResolverRegistry,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const retry = createApiKeyResolver(registry, provider, options);
	return ctx => (ctx.error === undefined ? initialKey : retry(ctx));
}
