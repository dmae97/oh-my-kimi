import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { searchWithKagi } from "../../src/web/kagi";
import { searchKagi } from "../../src/web/search/providers/kagi";
import { SearchProviderError } from "../../src/web/search/types";

describe("Kagi web search error handling", () => {
	beforeEach(() => {
		process.env.KAGI_API_KEY = "test-kagi-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KAGI_API_KEY;
	});

	it("surfaces beta access denial messages from JSON error bodies", async () => {
		const providerMessage =
			"Kagi Search API is in beta. Please contact support@kagi.com to enable API access for your account.";

		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ error: [{ code: 401, msg: providerMessage }] }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);

		try {
			await searchKagi({ query: "kagi beta" });
			expect.unreachable("expected searchKagi to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "kagi", status: 401 });
			expect((error as Error).message).toBe("kagi: 401 unauthorized");
		}
	});

	it("falls back to plain text for non-JSON error bodies", async () => {
		using _hook = hookFetch(() => new Response("upstream unavailable", { status: 503 }));

		await expect(searchWithKagi("plain text error")).rejects.toThrow("Kagi API error (503): upstream unavailable");
	});

	it("preserves successful search parsing", async () => {
		using _hook = hookFetch(
			() =>
				new Response(
					JSON.stringify({
						meta: { id: "req-kagi-success" },
						data: [
							{
								t: 0,
								url: "https://example.com/article",
								title: "Example Article",
								snippet: "Example snippet",
								published: "2025-01-01T00:00:00Z",
							},
							{ t: 1, list: ["What is Kagi Search API beta access?"] },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(searchWithKagi("success case")).resolves.toEqual({
			requestId: "req-kagi-success",
			sources: [
				{
					title: "Example Article",
					url: "https://example.com/article",
					snippet: "Example snippet",
					publishedDate: "2025-01-01T00:00:00Z",
				},
			],
			relatedQuestions: ["What is Kagi Search API beta access?"],
		});
	});
});
