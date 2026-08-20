import { fauxAssistantMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import {
	computeRetryDelayMs,
	failoverModelKey,
	isFailoverTriggerError,
	isRetryableAssistantError,
	nextRetryAttempt,
	retryBudgetForAssistantError,
} from "../src/core/provider-retry.ts";

function errorMessage(text: string | undefined) {
	return fauxAssistantMessage([], { stopReason: "error", ...(text === undefined ? {} : { errorMessage: text }) });
}

describe("isRetryableAssistantError", () => {
	it("rejects non-error stops and missing error text", () => {
		expect(isRetryableAssistantError(fauxAssistantMessage([]), 0)).toBe(false);
		expect(isRetryableAssistantError(errorMessage(undefined), 0)).toBe(false);
	});

	it("never retries context overflow — compaction owns that path", () => {
		expect(isRetryableAssistantError(errorMessage("maximum context length is 128000 tokens"), 128000)).toBe(false);
	});

	it("retries quota exhaustion so failover can save the turn", () => {
		expect(isRetryableAssistantError(errorMessage("usage limit reached for this cycle"), 0)).toBe(true);
	});

	it("retries transient provider errors including safety stops", () => {
		expect(isRetryableAssistantError(errorMessage("overloaded"), 0)).toBe(true);
		expect(isRetryableAssistantError(errorMessage("content/safety stop"), 0)).toBe(true);
		expect(isRetryableAssistantError(errorMessage("stop_reason=refusal"), 0)).toBe(true);
	});

	it("rejects permanent errors", () => {
		expect(isRetryableAssistantError(errorMessage("Permission denied: read-only filesystem"), 0)).toBe(false);
	});
});

describe("retryBudgetForAssistantError", () => {
	it("caps refusal retries at one while preserving the configured budget for transport failures", () => {
		expect(retryBudgetForAssistantError(errorMessage("stop_reason=refusal"), 3)).toBe(1);
		expect(retryBudgetForAssistantError(errorMessage("content/safety stop"), 0)).toBe(0);
		expect(retryBudgetForAssistantError(errorMessage("overloaded"), 3)).toBe(3);
	});
});

describe("nextRetryAttempt", () => {
	it("stays disabled or capped without advancing", () => {
		expect(nextRetryAttempt({ enabled: false, completedAttempts: 0, maxRetries: 3 })).toBeUndefined();
		expect(nextRetryAttempt({ enabled: true, completedAttempts: 3, maxRetries: 3 })).toBeUndefined();
	});

	it("advances within budget", () => {
		expect(nextRetryAttempt({ enabled: true, completedAttempts: 0, maxRetries: 3 })).toBe(1);
		expect(nextRetryAttempt({ enabled: true, completedAttempts: 2, maxRetries: 3 })).toBe(3);
	});
});

describe("computeRetryDelayMs", () => {
	it("backs off exponentially on same-model retry", () => {
		expect(computeRetryDelayMs(1000, 1, false)).toBe(1000);
		expect(computeRetryDelayMs(1000, 3, false)).toBe(4000);
	});

	it("caps the post-failover delay because safety stops fail fast", () => {
		expect(computeRetryDelayMs(1000, 5, true)).toBe(400);
		expect(computeRetryDelayMs(100, 1, true)).toBe(100);
	});
});

describe("isFailoverTriggerError", () => {
	it("triggers on safety stops and quota exhaustion", () => {
		expect(isFailoverTriggerError("content/safety stop")).toBe(true);
		expect(isFailoverTriggerError("usage limit reached for this cycle")).toBe(true);
	});

	it("does not trigger on plain transient or permanent errors", () => {
		expect(isFailoverTriggerError("overloaded")).toBe(false);
		expect(isFailoverTriggerError("Permission denied")).toBe(false);
		expect(isFailoverTriggerError(undefined)).toBe(false);
	});
});

describe("failoverModelKey", () => {
	it("builds the provider/id bookkeeping key", () => {
		expect(failoverModelKey("anthropic", "claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
		expect(failoverModelKey("xai", "grok-4.5")).toBe("xai/grok-4.5");
	});
});
