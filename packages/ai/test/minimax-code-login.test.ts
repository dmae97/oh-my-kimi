import { describe, expect, it } from "bun:test";
import { loginMiniMaxCode, loginMiniMaxCodeCn } from "@oh-my-pi/pi-ai/registry/oauth/minimax-code";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("MiniMax Coding Plan login", () => {
	it("opens the international platform and validates against the international API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];

		const fetchMock: FetchImpl = async input => {
			validationUrls.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const apiKey = await loginMiniMaxCode({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk-intl  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-intl");
		expect(authUrls).toEqual(["https://platform.minimax.io/subscribe/coding-plan"]);
		expect(validationUrls).toEqual(["https://api.minimax.io/v1/chat/completions"]);
	});

	it("opens the China platform and validates against the China API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];

		const fetchMock: FetchImpl = async input => {
			validationUrls.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const apiKey = await loginMiniMaxCodeCn({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk-cn  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-cn");
		expect(authUrls).toEqual(["https://platform.minimaxi.com/subscribe/coding-plan"]);
		expect(validationUrls).toEqual(["https://api.minimaxi.com/v1/chat/completions"]);
	});
});
