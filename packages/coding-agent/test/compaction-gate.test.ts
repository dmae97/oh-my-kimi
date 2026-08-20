import { fauxAssistantMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import { isSessionModelOverflow, shouldSkipCompactionCheck } from "../src/core/compaction-gate.ts";

const OVERFLOW_TEXT = "maximum context length is 128000 tokens";

function overflowMessage(provider = "anthropic", model = "claude-sonnet-4-5") {
	return { ...fauxAssistantMessage([], { stopReason: "error", errorMessage: OVERFLOW_TEXT }), provider, model };
}

describe("shouldSkipCompactionCheck", () => {
	const base = {
		enabled: true,
		skipAbortedCheck: true,
		stopReason: "stop",
		messageTimestamp: 2000,
		latestCompactionTimestamp: 1000,
	};

	it("skips when compaction is disabled", () => {
		expect(shouldSkipCompactionCheck({ ...base, enabled: false })).toBe(true);
	});

	it("skips aborted messages only when the aborted check is armed", () => {
		expect(shouldSkipCompactionCheck({ ...base, stopReason: "aborted" })).toBe(true);
		expect(shouldSkipCompactionCheck({ ...base, stopReason: "aborted", skipAbortedCheck: false })).toBe(false);
	});

	it("skips messages at or before the latest compaction boundary", () => {
		expect(shouldSkipCompactionCheck({ ...base, messageTimestamp: 1000 })).toBe(true);
		expect(shouldSkipCompactionCheck({ ...base, messageTimestamp: 999 })).toBe(true);
		expect(shouldSkipCompactionCheck({ ...base, messageTimestamp: 1001 })).toBe(false);
		expect(shouldSkipCompactionCheck({ ...base, latestCompactionTimestamp: undefined })).toBe(false);
	});
});

describe("isSessionModelOverflow", () => {
	it("counts overflow from the session's own model", () => {
		expect(
			isSessionModelOverflow({
				message: overflowMessage(),
				contextWindow: 128000,
				sessionProvider: "anthropic",
				sessionModelId: "claude-sonnet-4-5",
			}),
		).toBe(true);
	});

	it("ignores overflow from a different model after a switch", () => {
		expect(
			isSessionModelOverflow({
				message: overflowMessage("openai", "gpt-5.2"),
				contextWindow: 128000,
				sessionProvider: "anthropic",
				sessionModelId: "claude-sonnet-4-5",
			}),
		).toBe(false);
	});

	it("counts vision-route overflow only when the session model cannot see images", () => {
		const routed = overflowMessage("openai-codex", "gpt-5.6-luna");
		expect(
			isSessionModelOverflow({
				message: routed,
				contextWindow: 400000,
				sessionProvider: "deepseek",
				sessionModelId: "deepseek-v4-flash",
				sessionInputs: ["text"],
			}),
		).toBe(true);
		expect(
			isSessionModelOverflow({
				message: routed,
				contextWindow: 400000,
				sessionProvider: "anthropic",
				sessionModelId: "claude-sonnet-4-5",
				sessionInputs: ["text", "image"],
			}),
		).toBe(false);
	});

	it("ignores non-overflow errors even from the same model", () => {
		expect(
			isSessionModelOverflow({
				message: {
					...fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				},
				contextWindow: 128000,
				sessionProvider: "anthropic",
				sessionModelId: "claude-sonnet-4-5",
			}),
		).toBe(false);
	});

	it("never counts overflow without a session model", () => {
		expect(isSessionModelOverflow({ message: overflowMessage(), contextWindow: 128000 })).toBe(false);
	});
});
