import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("Anthropic search request body", () => {
	it("passes the session id as Messages metadata.user_id", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			let capturedBody: Record<string, unknown> | undefined;
			const fetchMock: FetchImpl = async (_input, init) => {
				capturedBody = JSON.parse(String(init?.body));
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

			await searchAnthropic({
				query: "gateway attribution requirements",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage,
				fetch: fetchMock,
			});

			expect(capturedBody?.metadata).toEqual({ user_id: "session-2295" });
		} finally {
			authStorage.close();
		}
	});
});
