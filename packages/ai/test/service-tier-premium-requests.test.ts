import { describe, expect, it } from "bun:test";
import { getPriorityPremiumRequests } from "../src/types";

describe("getPriorityPremiumRequests", () => {
	it("counts priority tier as one premium request on OpenAI", () => {
		expect(getPriorityPremiumRequests("priority", "openai")).toBe(1);
	});

	it("counts priority tier as one premium request on OpenAI Codex", () => {
		expect(getPriorityPremiumRequests("priority", "openai-codex")).toBe(1);
	});

	it("ignores non-priority paid tiers", () => {
		expect(getPriorityPremiumRequests("flex", "openai")).toBe(0);
		expect(getPriorityPremiumRequests("scale", "openai")).toBe(0);
	});

	it("ignores default and auto tiers", () => {
		expect(getPriorityPremiumRequests("default", "openai")).toBe(0);
		expect(getPriorityPremiumRequests("auto", "openai")).toBe(0);
	});

	it("ignores priority tier on providers that drop service_tier", () => {
		// Only `openai` and `openai-codex` send `service_tier`; anything else
		// silently discards the option, so we must not bill the request as
		// premium.
		expect(getPriorityPremiumRequests("priority", "github-copilot")).toBe(0);
		expect(getPriorityPremiumRequests("priority", "azure")).toBe(0);
		expect(getPriorityPremiumRequests("priority", "anthropic")).toBe(0);
	});

	it("returns zero when service tier is unset", () => {
		expect(getPriorityPremiumRequests(undefined, "openai")).toBe(0);
		expect(getPriorityPremiumRequests(null, "openai")).toBe(0);
	});
});
