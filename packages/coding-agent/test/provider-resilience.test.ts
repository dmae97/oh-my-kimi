import { describe, expect, it } from "vitest";
import {
	DEFAULT_SAFETY_FAILOVER_CANDIDATES,
	isContentSafetyStopMessage,
	isOrphanToolCallIdError,
	isStickySafetyModel,
	isTransientProviderErrorMessage,
	pickFailoverCandidate,
	resolveProviderResilience,
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

	it("resolves defaults with block + autoFailover on", () => {
		const r = resolveProviderResilience(undefined);
		expect(r.blockStickySafetyModels).toBe(true);
		expect(r.autoFailoverOnSafetyStop).toBe(true);
		expect(r.failoverCandidates[0]).toEqual({ provider: "kimi-coding", id: "k3" });
	});

	it("block message names model", () => {
		expect(stickySafetyBlockMessage("claude-fable-5", "anthropic")).toMatch(/claude-fable-5/);
		expect(stickySafetyBlockMessage("claude-fable-5", "anthropic")).toMatch(/blockStickySafetyModels/);
	});
});
