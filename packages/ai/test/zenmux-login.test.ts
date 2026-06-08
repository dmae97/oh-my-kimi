import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginZenMux } from "../src/registry/zenmux";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("zenmux login", () => {
	it("opens ZenMux key settings and validates against models endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://zenmux.ai/api/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-zenmux-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginZenMux({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "sk-zenmux-test";
			},
		});

		expect(authUrl).toBe("https://zenmux.ai/settings/keys");
		expect(authInstructions).toContain("Create or copy your ZenMux API key");
		expect(promptMessage).toBe("Paste your ZenMux API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(apiKey).toBe("sk-zenmux-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(
			loginZenMux({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginZenMux({})).rejects.toThrow("ZenMux login requires onPrompt callback");
	});

	it("surfaces models endpoint validation errors", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginZenMux({
				onPrompt: async () => "sk-zenmux-test",
			}),
		).rejects.toThrow("ZenMux API key validation failed (401)");
	});
});
