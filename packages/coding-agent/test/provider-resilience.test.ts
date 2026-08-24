import { describe, expect, it } from "vitest";
import {
	DEFAULT_SAFETY_FAILOVER_CANDIDATES,
	isContentSafetyStopMessage,
	isNoSafetyFailoverModel,
	isOrphanToolCallIdError,
	isQuotaExhaustionMessage,
	isStickySafetyModel,
	isTransientProviderErrorMessage,
	isUpstreamUnavailableMessage,
	modelRouteFamily,
	pickFailoverCandidate,
	resolveProviderResilience,
	sameModelRouteCandidates,
	shouldEjectStickySafetyModel,
	shouldHonorSafetyFailover,
	stickySafetyBlockMessage,
} from "../src/core/provider-resilience.ts";

describe("provider-resilience (root-level)", () => {
	it("detects sticky safety models (fable)", () => {
		expect(isStickySafetyModel("claude-fable-5", "anthropic")).toBe(true);
		expect(isStickySafetyModel("claude-fable-5")).toBe(true);
		expect(isStickySafetyModel("k3", "kimi-coding")).toBe(false);
		expect(isStickySafetyModel("claude-opus-4-8", "anthropic")).toBe(false);
	});

	it("detects content/safety stop messages", () => {
		expect(
			isContentSafetyStopMessage(
				"Model ended the turn with a content/safety stop (stop_reason=refusal); the response was not completed.",
			),
		).toBe(true);
		expect(isContentSafetyStopMessage("rate limit exceeded")).toBe(false);
	});

	it("detects K3 orphan tool_call_id errors", () => {
		expect(
			isOrphanToolCallIdError(
				'400 {"error":{"type":"invalid_request_error","message":"tool_call_id  is not found"}}',
			),
		).toBe(true);
		expect(isOrphanToolCallIdError("tool timeout")).toBe(false);
	});

	it("marks terminated / invalid_request / safety stop as transient", () => {
		expect(isTransientProviderErrorMessage("terminated")).toBe(true);
		expect(isTransientProviderErrorMessage("tool_call_id is not found")).toBe(true);
		expect(isTransientProviderErrorMessage("content/safety stop (stop_reason=refusal)")).toBe(true);
		// relay-injected synthetic stream errors must retry/failover, not surface
		expect(isTransientProviderErrorMessage("JSON error injected into SSE stream")).toBe(true);
		expect(isTransientProviderErrorMessage("payload injected into SSE stream")).toBe(true);
		expect(isTransientProviderErrorMessage("Authentication failed")).toBe(false);
	});

	it("picks first allowed non-sticky failover candidate", () => {
		const pick = pickFailoverCandidate(
			DEFAULT_SAFETY_FAILOVER_CANDIDATES,
			{ provider: "anthropic", id: "claude-fable-5" },
			(c) => c.provider === "kimi-coding" && c.id === "k3",
		);
		expect(pick).toEqual({ provider: "kimi-coding", id: "k3" });
	});

	it("opus-5 is NOT sticky-blocked (selectable) but still a safety-stop failover SOURCE", () => {
		// Regression lock for v10.0-Ω: failover source gate must NOT require isStickySafetyModel.
		// claude-opus-5 emits stop_reason=refusal FPs; blockSticky must stay fable-only so
		// users can still deliberately select opus, while autoFailover runs for any safety stop.
		expect(isStickySafetyModel("claude-opus-5", "anthropic")).toBe(false);
		expect(isStickySafetyModel("claude-sonnet-4-5", "anthropic")).toBe(false);
		expect(
			isContentSafetyStopMessage(
				"Error: kind=provider_refusal provider/model=anthropic/claude-opus-5 message=content/safety stop",
			),
		).toBe(true);
		const pick = pickFailoverCandidate(
			DEFAULT_SAFETY_FAILOVER_CANDIDATES,
			{ provider: "anthropic", id: "claude-opus-5" },
			(c) => c.provider === "kimi-coding" && c.id === "k3",
		);
		expect(pick).toEqual({ provider: "kimi-coding", id: "k3" });
	});

	it("skips current model and sticky candidates", () => {
		const pick = pickFailoverCandidate(
			[
				{ provider: "anthropic", id: "claude-fable-5" },
				{ provider: "kimi-coding", id: "k3" },
			],
			{ provider: "kimi-coding", id: "k3" },
			() => true,
		);
		// only fable + k3; fable sticky skipped, k3 is current → undefined
		expect(pick).toBeUndefined();
	});

	it("v10.3-Ω: advances the chain when prior candidates already refused (blacklist)", () => {
		// Regression lock: failover must NOT re-pick the same candidate every retry.
		// agent-session keeps a _refusedModels set and excludes them via isAllowed.
		const candidates = [
			{ provider: "xai", id: "grok-4.5" },
			{ provider: "deepseek", id: "deepseek-v4-pro" },
			{ provider: "deepseek", id: "deepseek-v4-flash" },
		];
		const refused = new Set<string>();
		const isAllowed = (c: { provider: string; id: string }) => !refused.has(`${c.provider}/${c.id}`);

		// 1st refusal: claude-opus-5 → grok-4.5
		let pick = pickFailoverCandidate(candidates, { provider: "anthropic", id: "claude-opus-5" }, isAllowed);
		expect(pick).toEqual({ provider: "xai", id: "grok-4.5" });

		// grok also refuses → blacklist it, advance to deepseek-v4-pro
		refused.add("xai/grok-4.5");
		pick = pickFailoverCandidate(candidates, { provider: "xai", id: "grok-4.5" }, isAllowed);
		expect(pick).toEqual({ provider: "deepseek", id: "deepseek-v4-pro" });

		// deepseek-pro refuses → advance to deepseek-v4-flash
		refused.add("deepseek/deepseek-v4-pro");
		pick = pickFailoverCandidate(candidates, { provider: "deepseek", id: "deepseek-v4-pro" }, isAllowed);
		expect(pick).toEqual({ provider: "deepseek", id: "deepseek-v4-flash" });

		// all refused → undefined (no infinite same-model loop)
		refused.add("deepseek/deepseek-v4-flash");
		pick = pickFailoverCandidate(candidates, { provider: "deepseek", id: "deepseek-v4-flash" }, isAllowed);
		expect(pick).toBeUndefined();
	});

	it("honors safety failover only when the model is not CLI-pinned", () => {
		expect(shouldHonorSafetyFailover({ autoFailoverOnSafetyStop: true, modelPinned: false })).toBe(true);
		expect(shouldHonorSafetyFailover({ autoFailoverOnSafetyStop: true, modelPinned: true })).toBe(false);
		expect(shouldHonorSafetyFailover({ autoFailoverOnSafetyStop: false, modelPinned: false })).toBe(false);
	});

	it("never failovers fable/opus/sonnet on a safety stop", () => {
		expect(isNoSafetyFailoverModel("claude-fable-5", "anthropic")).toBe(true);
		expect(isNoSafetyFailoverModel("claude-opus-5", "anthropic")).toBe(true);
		expect(isNoSafetyFailoverModel("claude-sonnet-5", "anthropic")).toBe(true);
		expect(isNoSafetyFailoverModel("k3", "kimi-coding")).toBe(false);
		expect(
			shouldHonorSafetyFailover({
				autoFailoverOnSafetyStop: true,
				modelPinned: false,
				modelId: "claude-opus-5",
				provider: "anthropic",
			}),
		).toBe(false);
		expect(
			shouldHonorSafetyFailover({
				autoFailoverOnSafetyStop: true,
				modelPinned: false,
				modelId: "k3",
				provider: "kimi-coding",
			}),
		).toBe(true);
	});

	it("ejects sticky models only when they are not CLI-pinned", () => {
		expect(shouldEjectStickySafetyModel({ blockStickySafetyModels: true, modelPinned: false })).toBe(true);
		expect(shouldEjectStickySafetyModel({ blockStickySafetyModels: true, modelPinned: true })).toBe(false);
		expect(shouldEjectStickySafetyModel({ blockStickySafetyModels: false, modelPinned: false })).toBe(false);
	});

	it("resolves defaults with block + autoFailover on", () => {
		const r = resolveProviderResilience(undefined);
		expect(r.blockStickySafetyModels).toBe(true);
		expect(r.autoFailoverOnSafetyStop).toBe(true);
		expect(r.failoverCandidates.slice(0, 2)).toEqual([
			{ provider: "kimi-coding", id: "k3" },
			{ provider: "modelstudio-maas", id: "qwen3.8-max-preview" },
		]);
	});

	it("block message names model and recommended fallbacks", () => {
		const message = stickySafetyBlockMessage("claude-fable-5", "anthropic");
		expect(message).toMatch(/claude-fable-5/);
		expect(message).toMatch(/blockStickySafetyModels/);
		expect(message).toMatch(/kimi-coding\/k3/);
		expect(message).toMatch(/modelstudio-maas\/qwen3\.8-max-preview/);
	});
});

describe("isQuotaExhaustionMessage", () => {
	it("matches kimi billing-cycle quota errors (403 permission_error body)", () => {
		expect(
			isQuotaExhaustionMessage(
				'403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing"},"type":"error"}',
			),
		).toBe(true);
	});

	it("matches generic quota/balance shapes", () => {
		expect(isQuotaExhaustionMessage("insufficient_quota")).toBe(true);
		expect(isQuotaExhaustionMessage("Your available balance is 0")).toBe(true);
		expect(isQuotaExhaustionMessage("Monthly usage limit reached")).toBe(true);
		expect(isQuotaExhaustionMessage("GoUsageLimitError")).toBe(true);
	});

	it("does not match plain auth or transient rate-limit errors", () => {
		expect(isQuotaExhaustionMessage("403 forbidden")).toBe(false);
		expect(isQuotaExhaustionMessage("invalid api key")).toBe(false);
		expect(isQuotaExhaustionMessage("429 too many requests")).toBe(false);
		expect(isQuotaExhaustionMessage(undefined)).toBe(false);
	});
});

describe("isUpstreamUnavailableMessage", () => {
	it("matches gateway 5xx passthroughs and dropped streams", () => {
		expect(isUpstreamUnavailableMessage("503 Upstream request failed: Endpoint is unavailable.")).toBe(true);
		expect(isUpstreamUnavailableMessage("Stream ended without finish_reason")).toBe(true);
		expect(isUpstreamUnavailableMessage("502 Bad Gateway")).toBe(true);
		expect(isUpstreamUnavailableMessage("upstream connect error")).toBe(true);
	});

	it("does not match transcript-shape or auth errors", () => {
		expect(isUpstreamUnavailableMessage("tool_call_id is not found")).toBe(false);
		expect(isUpstreamUnavailableMessage("401 unauthorized")).toBe(false);
		expect(isUpstreamUnavailableMessage("429 too many requests")).toBe(false);
		expect(isUpstreamUnavailableMessage(undefined)).toBe(false);
	});
});

describe("model route families (ox-alpha rotation)", () => {
	const openrouterRoute = { provider: "openrouter", id: "stealth/ox-alpha", name: "Ox Alpha" };
	const opencodeGoRoute = { provider: "opencode-go", id: "ox-alpha-free", name: "Ox Alpha Free (Unlimited)" };
	const opencodeRoute = { provider: "opencode", id: "x-preview-f-free", name: "Ox Alpha Free (Unlimited)" };
	const kimiRoute = { provider: "kimi-coding", id: "k3", name: "Kimi K3" };

	it("groups ox-alpha alias routes by id or display name", () => {
		expect(modelRouteFamily(openrouterRoute)).toBe("ox-alpha");
		expect(modelRouteFamily(opencodeGoRoute)).toBe("ox-alpha");
		// x-preview-f-free only aligns through its display name.
		expect(
			modelRouteFamily({ provider: "opencode", id: "x-preview-f-free", name: "Ox Alpha Free (Unlimited)" }),
		).toBe("ox-alpha");
		expect(modelRouteFamily(kimiRoute)).toBeUndefined();
		// Near-miss ids must not match: boundary before "ox" is required.
		expect(modelRouteFamily({ provider: "p", id: "box-alpha-pro", name: "Box Alpha Pro" })).toBeUndefined();
	});

	it("lists the other routes of the same family, excluding the failed one", () => {
		const available = [openrouterRoute, opencodeGoRoute, opencodeRoute, kimiRoute];
		expect(sameModelRouteCandidates(opencodeGoRoute, available)).toEqual([openrouterRoute, opencodeRoute]);
		expect(sameModelRouteCandidates(openrouterRoute, available)).toEqual([opencodeGoRoute, opencodeRoute]);
		// Non-family models have no rotation targets.
		expect(sameModelRouteCandidates(kimiRoute, available)).toEqual([]);
	});
});
