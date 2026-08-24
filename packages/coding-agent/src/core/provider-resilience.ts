/**
 * Provider resilience — root-level recovery for sticky safety models and
 * sanitize-and-retry protocol failures (orphan tool_call_id, terminated streams).
 *
 * This is not a jailbreak layer. It keeps sessions alive when a provider
 * false-positives or returns a sticky transcript-shape error.
 */

export type FailoverCandidate = Readonly<{
	readonly provider: string;
	readonly id: string;
}>;

/** Models known to emit high false-positive content/safety stops on coding work. */
export const STICKY_SAFETY_MODEL_RE = /fable/i;

/** Claude lines that must stay on-model when they refuse. No DeepSeek hop. */
export const NO_SAFETY_FAILOVER_MODEL_RE = /(?:claude-)?(?:fable|opus|sonnet)/i;

/** Default failover chain when a sticky safety model refuses a turn. */
export const DEFAULT_SAFETY_FAILOVER_CANDIDATES: readonly FailoverCandidate[] = [
	{ provider: "kimi-coding", id: "k3" },
	{ provider: "modelstudio-maas", id: "qwen3.8-max-preview" },
	{ provider: "xai", id: "grok-4.5" },
	{ provider: "deepseek", id: "deepseek-v4-pro" },
	{ provider: "deepseek", id: "deepseek-v4-flash" },
	{ provider: "modelstudio-maas", id: "deepseek-v4-pro" },
	{ provider: "kimi-coding", id: "kimi-for-coding" },
] as const;

export type ProviderResilienceSettings = Readonly<{
	/** When true (default), refuse selecting sticky safety models (e.g. claude-fable-5). */
	readonly blockStickySafetyModels?: boolean;
	/** When true (default), auto-switch model on content/safety stop before retry. */
	readonly autoFailoverOnSafetyStop?: boolean;
	/** Ordered failover targets. Falls back to DEFAULT_SAFETY_FAILOVER_CANDIDATES. */
	readonly failoverCandidates?: readonly FailoverCandidate[];
}>;

export const DEFAULT_PROVIDER_RESILIENCE: Required<
	Pick<ProviderResilienceSettings, "blockStickySafetyModels" | "autoFailoverOnSafetyStop">
> & {
	readonly failoverCandidates: readonly FailoverCandidate[];
} = {
	blockStickySafetyModels: true,
	autoFailoverOnSafetyStop: true,
	failoverCandidates: DEFAULT_SAFETY_FAILOVER_CANDIDATES,
};

export function isStickySafetyModel(modelId: string | undefined, provider?: string | undefined): boolean {
	const id = (modelId ?? "").trim();
	if (!id) return false;
	if (STICKY_SAFETY_MODEL_RE.test(id)) return true;
	const p = (provider ?? "").toLowerCase();
	return p.includes("anthropic") && STICKY_SAFETY_MODEL_RE.test(id);
}

/** Fable / Opus / Sonnet stay on the requested id after a safety stop. */
export function isNoSafetyFailoverModel(modelId: string | undefined, provider?: string | undefined): boolean {
	const id = (modelId ?? "").trim();
	if (!id) return false;
	if (NO_SAFETY_FAILOVER_MODEL_RE.test(id)) return true;
	const p = (provider ?? "").toLowerCase();
	return p.includes("anthropic") && NO_SAFETY_FAILOVER_MODEL_RE.test(id);
}

export function isContentSafetyStopMessage(text: string | undefined): boolean {
	if (!text) return false;
	return /content\/safety stop|stop_reason\s*=\s*(refusal|sensitive)|safety stop|provider\.refusal|kind=provider_refusal/i.test(
		text,
	);
}

/**
 * Billing/quota exhaustion ("usage limit for this billing cycle",
 * "insufficient_quota", zero balance, ...). Same-model retry is useless until
 * the cycle resets, but the turn can still be saved by failing over to another
 * candidate — so these classify as retryable-with-failover, not auth-fatal.
 */
export function isQuotaExhaustionMessage(text: string | undefined): boolean {
	if (!text) return false;
	return /usage limit|GoUsageLimitError|FreeUsageLimitError|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		text,
	);
}

/** Orphan tool results / Kimi-K3 protocol shape errors that heal after sanitize+retry. */
export function isOrphanToolCallIdError(text: string | undefined): boolean {
	if (!text) return false;
	return /tool_call_id\s+is\s+not\s+found|tool_call_id\s+not\s+found|unknown\s+tool_call_id/i.test(text);
}

/**
 * Transient upstream availability failures: gateway 5xx passthroughs
 * ("503 Upstream request failed", "Endpoint is unavailable") and dropped
 * streams that never carried a finish reason ("Stream ended without
 * finish_reason"). Transport problems, not transcript-shape problems — they
 * heal by backoff/retry or switching model, never by transcript sanitization.
 */
export function isUpstreamUnavailableMessage(text: string | undefined): boolean {
	if (!text) return false;
	return /upstream(?: request)? failed|upstream connect|endpoint (?:is )?unavailable|stream ended without finish_reason|\b50[0234]\b/i.test(
		text,
	);
}

/**
 * Route families: the same underlying model served by several provider
 * routes. Matched on the model id OR display name so alias routes like
 * `openrouter/stealth/ox-alpha`, `opencode-go/ox-alpha-free`, and
 * `opencode/x-preview-f-free` ("Ox Alpha Free (Unlimited)") rotate as one
 * ox-alpha family.
 */
const MODEL_ROUTE_FAMILIES: readonly { readonly pattern: RegExp; readonly family: string }[] = [
	{ pattern: /(?:^|[-_/])ox[-_ ]?alpha(?:[-_/\s(]|$)/i, family: "ox-alpha" },
];

/** Family key for a model route, or undefined when it has no known alias group. */
export function modelRouteFamily(model: {
	readonly provider?: string | undefined;
	readonly id: string;
	readonly name?: string | undefined;
}): string | undefined {
	for (const { pattern, family } of MODEL_ROUTE_FAMILIES) {
		if (pattern.test(model.id)) return family;
		if (model.name && pattern.test(model.name)) return family;
	}
	return undefined;
}

/**
 * Alternative provider routes serving the same model family as
 * {@link failed}, in registry order, excluding the failed route itself.
 * Callers filter by authentication and per-turn failure bookkeeping.
 */
export function sameModelRouteCandidates<
	T extends { readonly provider: string; readonly id: string; readonly name?: string | undefined },
>(
	failed: { readonly provider: string; readonly id: string; readonly name?: string | undefined },
	available: readonly T[],
): T[] {
	const family = modelRouteFamily(failed);
	if (!family) return [];
	const candidates: T[] = [];
	for (const model of available) {
		if (model.provider === failed.provider && model.id === failed.id) continue;
		if (modelRouteFamily(model) === family) candidates.push(model);
	}
	return candidates;
}

/**
 * Errors the agent loop may auto-retry (after optional failover / message sanitize).
 * Kept in one place so agent-session and tests share the same contract.
 */
export function isTransientProviderErrorMessage(text: string | undefined): boolean {
	if (!text) return false;
	return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|\bterminated\b|retry delay|content\/safety stop|stop_reason\s*=\s*(refusal|sensitive)|safety stop|tool_call_id\s+is\s+not\s+found|tool_call_id\s+not\s+found|invalid_request_error|json error injected into sse stream|injected into sse/i.test(
		text,
	);
}

export function resolveFailoverCandidates(
	settings: ProviderResilienceSettings | undefined,
): readonly FailoverCandidate[] {
	const custom = settings?.failoverCandidates;
	if (custom && custom.length > 0) return custom;
	return DEFAULT_SAFETY_FAILOVER_CANDIDATES;
}

/** Explicit `--model` / `--provider` pins stay on the requested model. */
export function shouldHonorSafetyFailover(options: {
	readonly autoFailoverOnSafetyStop: boolean;
	readonly modelPinned: boolean;
	readonly modelId?: string;
	readonly provider?: string;
}): boolean {
	if (!options.autoFailoverOnSafetyStop || options.modelPinned) return false;
	return !isNoSafetyFailoverModel(options.modelId, options.provider);
}

/** Sticky-model eject still applies unless the user pinned that model. */
export function shouldEjectStickySafetyModel(options: {
	readonly blockStickySafetyModels: boolean;
	readonly modelPinned: boolean;
}): boolean {
	return options.blockStickySafetyModels && !options.modelPinned;
}

export function resolveProviderResilience(settings: ProviderResilienceSettings | undefined): {
	readonly blockStickySafetyModels: boolean;
	readonly autoFailoverOnSafetyStop: boolean;
	readonly failoverCandidates: readonly FailoverCandidate[];
} {
	return {
		blockStickySafetyModels: settings?.blockStickySafetyModels ?? DEFAULT_PROVIDER_RESILIENCE.blockStickySafetyModels,
		autoFailoverOnSafetyStop:
			settings?.autoFailoverOnSafetyStop ?? DEFAULT_PROVIDER_RESILIENCE.autoFailoverOnSafetyStop,
		failoverCandidates: resolveFailoverCandidates(settings),
	};
}

/**
 * Pick first failover candidate that is not the current model and passes `isAllowed`.
 * Pure — caller performs auth checks and setModel.
 */
export function pickFailoverCandidate(
	candidates: readonly FailoverCandidate[],
	current: { readonly provider?: string; readonly id?: string } | undefined,
	isAllowed: (candidate: FailoverCandidate) => boolean,
): FailoverCandidate | undefined {
	for (const c of candidates) {
		if (current && c.provider === current.provider && c.id === current.id) continue;
		if (isStickySafetyModel(c.id, c.provider)) continue;
		if (!isAllowed(c)) continue;
		return c;
	}
	return undefined;
}

export function stickySafetyBlockMessage(modelId: string, provider: string): string {
	return (
		`Blocked sticky safety model ${provider}/${modelId} (providerResilience.blockStickySafetyModels). ` +
		`Use kimi-coding/k3, modelstudio-maas/qwen3.8-max-preview, grok-4.5, or deepseek; ` +
		`or set providerResilience.blockStickySafetyModels=false.`
	);
}
