import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage as CodingAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeCaptureFetch(): { fetch: FetchImpl; body: () => Record<string, unknown> | undefined } {
	let captured: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		const raw = init?.body;
		const text =
			typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
		captured = JSON.parse(text);
		return new Response(
			JSON.stringify({
				id: "msg_test",
				model: "claude-haiku-4-5",
				content: [],
				usage: { input_tokens: 1, output_tokens: 2 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	return { fetch, body: () => captured };
}

describe("Anthropic search request body", () => {
	it("forwards the raw session id as metadata.user_id for API-key auth", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-apikey-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "gateway attribution requirements",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage,
				fetch: cap.fetch,
			});

			expect(cap.body()?.metadata).toEqual({ user_id: "session-2295" });
		} finally {
			authStorage.close();
		}
	});

	it("builds a Claude-Code-shaped metadata.user_id for OAuth auth", async () => {
		const accountUuid = "abcd1234-abcd-1234-abcd-1234abcd1234";
		const oauthAuthStorage = {
			resolver: () => () => Promise.resolve("sk-ant-oat-fake-oauth-token"),
			getOAuthAccountId: () => accountUuid,
			hasAuth: () => true,
		} as unknown as AuthStorage;

		const cap = makeCaptureFetch();
		await searchAnthropic({
			query: "oauth attribution",
			systemPrompt: "Use web search.",
			sessionId: "session-2295",
			authStorage: oauthAuthStorage,
			fetch: cap.fetch,
		});

		const metadata = cap.body()?.metadata as { user_id: string } | undefined;
		expect(metadata).toBeDefined();
		const userId = JSON.parse(metadata!.user_id) as {
			session_id: string;
			account_uuid?: string;
			device_id?: string;
		};
		expect(userId.session_id).toBe("session-2295");
		expect(userId.account_uuid).toBe(accountUuid);
		expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
	});
});
