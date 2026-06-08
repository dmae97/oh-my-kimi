import { afterEach, describe, expect, it, vi } from "bun:test";

import { loginDeepSeek, normalizeDeepSeekApiKey } from "../src/registry/deepseek";
import type { OAuthController } from "../src/registry/oauth/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function makeController(paste: string): OAuthController {
	return {
		onAuth: () => {},
		onPrompt: async () => paste,
	};
}

describe("loginDeepSeek validation", () => {
	it("validates against GET /v1/models and returns the trimmed key on 200", async () => {
		const calls: Array<{ url: string; method?: string; auth?: string | null }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(init?.headers ?? {});
			calls.push({ url, method: init?.method, auth: headers.get("authorization") });
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "deepseek-chat", object: "model" },
						{ id: "deepseek-reasoner", object: "model" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const key = await loginDeepSeek(makeController("  sk-valid-key  "));

		expect(key).toBe("sk-valid-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(calls[0]?.url).toBe("https://api.deepseek.com/v1/models");
		expect(calls[0]?.method ?? "GET").toBe("GET");
		expect(calls[0]?.auth).toBe("Bearer sk-valid-key");
	});

	it("throws a validation error when /v1/models returns 401", async () => {
		const fetchMock = vi.fn(
			async () => new Response("invalid api key", { status: 401, headers: { "Content-Type": "text/plain" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(loginDeepSeek(makeController("sk-bad-key"))).rejects.toThrow(/deepseek.*401/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("strips a pasted 'Bearer ' prefix before validating", async () => {
		const seen: string[] = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push(new Headers(init?.headers ?? {}).get("authorization") ?? "");
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const key = await loginDeepSeek(makeController("Bearer sk-with-prefix"));

		expect(key).toBe("sk-with-prefix");
		expect(seen[0]).toBe("Bearer sk-with-prefix"); // exactly one Bearer, not nested
	});

	it("rejects an empty paste before touching the network", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(loginDeepSeek(makeController("   "))).rejects.toThrow(/API key is required/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("normalizeDeepSeekApiKey", () => {
	it("trims whitespace", () => {
		expect(normalizeDeepSeekApiKey("  sk-abc  ")).toBe("sk-abc");
	});

	it("strips a leading 'Bearer ' prefix (case-insensitive)", () => {
		expect(normalizeDeepSeekApiKey("Bearer sk-abc")).toBe("sk-abc");
		expect(normalizeDeepSeekApiKey("bearer\tsk-abc")).toBe("sk-abc");
	});

	it("throws when only a Bearer prefix is supplied", () => {
		expect(() => normalizeDeepSeekApiKey("Bearer    ")).toThrow(/empty after stripping/i);
	});
});
