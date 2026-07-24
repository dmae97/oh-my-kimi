import { describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Headers): Error & { status?: number; headers?: Headers } {
	const error = new Error(`HTTP ${status ?? "network"}`) as Error & { status?: number; headers?: Headers };
	error.status = status;
	error.headers = headers ?? new Headers();
	return error;
}

describe("retryProviderRequest", () => {
	it("returns the first successful response without retrying", async () => {
		const request = vi.fn().mockResolvedValue("ok");
		await expect(retryProviderRequest(request, { maxRetries: 3 })).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("retries transient status errors and then succeeds", async () => {
		const request = vi.fn().mockRejectedValueOnce(providerError(429)).mockResolvedValueOnce("ok");
		await expect(retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 1 })).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("retries network-level errors without a status", async () => {
		const request = vi.fn().mockRejectedValueOnce(providerError(undefined)).mockResolvedValueOnce("ok");
		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1 })).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry deterministic client errors", async () => {
		const request = vi.fn().mockRejectedValue(providerError(400));
		await expect(retryProviderRequest(request, { maxRetries: 3, maxRetryDelayMs: 1 })).rejects.toThrow("HTTP 400");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry non-provider errors", async () => {
		const request = vi.fn().mockRejectedValue(new TypeError("boom"));
		await expect(retryProviderRequest(request, { maxRetries: 3, maxRetryDelayMs: 1 })).rejects.toThrow("boom");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("honors x-should-retry header overrides", async () => {
		const forceRetry = vi
			.fn()
			.mockRejectedValueOnce(providerError(400, new Headers({ "x-should-retry": "true" })))
			.mockResolvedValueOnce("ok");
		await expect(retryProviderRequest(forceRetry, { maxRetries: 1, maxRetryDelayMs: 1 })).resolves.toBe("ok");

		const forceNoRetry = vi.fn().mockRejectedValue(providerError(503, new Headers({ "x-should-retry": "false" })));
		await expect(retryProviderRequest(forceNoRetry, { maxRetries: 3, maxRetryDelayMs: 1 })).rejects.toThrow(
			"HTTP 503",
		);
		expect(forceNoRetry).toHaveBeenCalledTimes(1);
	});

	it("aborts promptly during the backoff sleep", async () => {
		const controller = new AbortController();
		const request = vi.fn().mockRejectedValue(providerError(429, new Headers({ "retry-after": "30" })));
		const started = Date.now();
		setTimeout(() => controller.abort(), 20);
		await expect(retryProviderRequest(request, { maxRetries: 3, signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("normalizes an already-aborted signal to AbortError", async () => {
		const controller = new AbortController();
		controller.abort();
		const request = vi.fn().mockRejectedValue(providerError(503));
		await expect(retryProviderRequest(request, { maxRetries: 2, signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("fails immediately when the server-requested delay exceeds the cap", async () => {
		const request = vi.fn().mockRejectedValue(providerError(429, new Headers({ "retry-after": "120" })));
		await expect(retryProviderRequest(request, { maxRetries: 3, maxRetryDelayMs: 1_000 })).rejects.toThrow(
			/Server requested 120s retry delay/,
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
