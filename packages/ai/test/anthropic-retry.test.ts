import { describe, expect, it } from "bun:test";
import { isProviderRetryableError } from "@oh-my-pi/pi-ai/providers/anthropic";

describe("isProviderRetryableError", () => {
	it("retries known transient rate-limit errors", () => {
		expect(isProviderRetryableError(new Error("Rate limit exceeded"))).toBe(true);
		expect(isProviderRetryableError(new Error("error 1302 from upstream"))).toBe(true);
	});

	it("retries transient stream parse errors and pre-content envelope failures", () => {
		expect(isProviderRetryableError(new Error("JSON Parse error: Unterminated string"))).toBe(true);
		expect(isProviderRetryableError(new Error("Unexpected end of JSON input"))).toBe(true);
		expect(
			isProviderRetryableError(
				new Error("Anthropic stream envelope error: received content_block_start before message_start"),
			),
		).toBe(true);
		expect(
			isProviderRetryableError(new Error("Anthropic stream envelope error: stream ended before message_start")),
		).toBe(true);
	});

	it("does not classify post-content envelope failures as provider-retryable", () => {
		expect(
			isProviderRetryableError(
				new Error("Anthropic stream envelope error: stream ended before terminal stop signal"),
			),
		).toBe(false);
	});

	it("retries HTTP/2 stream errors (INTERNAL_ERROR)", () => {
		expect(
			isProviderRetryableError(new Error("stream error: stream ID 391; INTERNAL_ERROR; received from peer")),
		).toBe(true);
	});

	it("retries Bun socket closure errors", () => {
		expect(
			isProviderRetryableError(
				new Error(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				),
			),
		).toBe(true);
	});

	it("retries first-event timeout errors", () => {
		expect(isProviderRetryableError(new Error("Anthropic stream timed out while waiting for the first event"))).toBe(
			true,
		);
	});

	it("does not retry non-transient validation errors", () => {
		expect(isProviderRetryableError(new Error("Invalid tool schema"))).toBe(false);
		expect(isProviderRetryableError(new Error("Bad request"))).toBe(false);
	});

	it("retries Copilot transient model_not_supported only for github-copilot provider", () => {
		const err = new Error("400 The requested model is not supported.");
		(err as unknown as { status: number; code: string }).status = 400;
		(err as unknown as { status: number; code: string }).code = "model_not_supported";
		expect(isProviderRetryableError(err, "github-copilot")).toBe(true);
		expect(isProviderRetryableError(err, "anthropic")).toBe(false);
		expect(isProviderRetryableError(err)).toBe(false);
	});
});
