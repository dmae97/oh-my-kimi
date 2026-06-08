import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginNanoGPT } from "../src/registry/nanogpt";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("nanogpt login", () => {
	it("validates API key without requiring a specific model entitlement", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://nano-gpt.com/api/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-nano-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginNanoGPT({
			onPrompt: async () => "sk-nano-test",
		});

		expect(apiKey).toBe("sk-nano-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces validation errors from models endpoint", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response('{"code":"invalid_api_key"}', {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			loginNanoGPT({
				onPrompt: async () => "sk-nano-test",
			}),
		).rejects.toThrow("NanoGPT API key validation failed (401)");
	});
});
