import { describe, expect, test, vi } from "bun:test";
import { loginNovita } from "../src/registry/novita";
import { getOAuthProviders } from "../src/registry/oauth";
import type { FetchImpl } from "../src/types";

describe("Novita login", () => {
	test("registers Novita as an available API-key provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "novita");
		expect(provider).toMatchObject({ id: "novita", name: "Novita", available: true });
	});

	test("validates the pasted key against the authenticated balance endpoint", async () => {
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const prompts: Array<{ message: string; placeholder?: string }> = [];
		const progress: string[] = [];
		const requests: Array<{
			url: string;
			method: string | undefined;
			authorization: string | null;
			contentType: string | null;
		}> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				method: init?.method,
				authorization: headers.get("authorization"),
				contentType: headers.get("content-type"),
			});
			return Response.json({ availableBalance: "0" });
		});

		const apiKey = await loginNovita({
			onAuth: info => authEvents.push(info),
			onPrompt: async prompt => {
				prompts.push(prompt);
				return "  novita-test-key  ";
			},
			onProgress: message => progress.push(message),
			fetch: fetchMock,
		});

		expect(apiKey).toBe("novita-test-key");
		expect(authEvents).toEqual([
			{
				url: "https://novita.ai/settings/key-management",
				instructions: "Create or copy your API key from the Novita dashboard",
			},
		]);
		expect(prompts).toEqual([{ message: "Paste your Novita API key", placeholder: "sk_..." }]);
		expect(progress).toEqual(["Validating API key..."]);
		expect(requests).toEqual([
			{
				url: "https://api.novita.ai/openapi/v1/billing/balance/detail",
				method: "GET",
				authorization: "Bearer novita-test-key",
				contentType: "application/json",
			},
		]);
	});

	test("rejects a key rejected by Novita", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({ code: 401, reason: "UNAUTHORIZED", message: "key not found", metadata: {} }, { status: 401 }),
		);

		await expect(
			loginNovita({
				onPrompt: async () => "invalid-novita-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Novita API key validation failed (401)");
	});
});
