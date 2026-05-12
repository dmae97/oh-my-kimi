import { describe, expect, it } from "bun:test";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@oh-my-pi/pi-ai/rate-limit-utils";

describe("parseRateLimitReason", () => {
	it("classifies Google Quota exceeded as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Quota exceeded for aiplatform.googleapis.com"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// "Resource has been exhausted (e.g. check quota)" is a quota/daily-limit error — long wait.
	// Only the literal phrase "resource exhausted" (gRPC status name) is MODEL_CAPACITY.
	it("classifies 'Resource has been exhausted (e.g. check quota)' as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies 'resource exhausted' (exact gRPC phrase) as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies Too many requests as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Cloud Code Assist API error (429): Too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies per minute errors as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Requests per minute limit reached")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies overloaded 529 as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Service overloaded 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies internal server error as SERVER_ERROR", () => {
		expect(parseRateLimitReason("Internal Server Error (500)")).toBe("SERVER_ERROR");
	});

	it("returns UNKNOWN for unrecognised messages", () => {
		expect(parseRateLimitReason("Something completely unexpected happened")).toBe("UNKNOWN");
	});

	it("classifies Codex usage limit error as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Codex error event: The usage limit has been reached (code=usage_limit_reached)"),
		).toBe("QUOTA_EXHAUSTED");
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 45–75s range for MODEL_CAPACITY_EXHAUSTED (jitter)", () => {
		for (let i = 0; i < 20; i++) {
			const ms = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
			expect(ms).toBeGreaterThanOrEqual(45_000);
			expect(ms).toBeLessThanOrEqual(75_000);
		}
	});
});
