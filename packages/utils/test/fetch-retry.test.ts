import { describe, expect, it } from "bun:test";
import { fetchWithRetry } from "../src/fetch-retry";

describe("fetchWithRetry", () => {
	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});
});
