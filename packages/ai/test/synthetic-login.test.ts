import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginSynthetic } from "../src/utils/oauth/synthetic";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("synthetic login", () => {
	it("validates API keys against the models endpoint instead of a deprecated model", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.synthetic.new/openai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-synthetic-test" });
			return new Response(JSON.stringify({ data: [{ id: "hf:zai-org/GLM-5.1" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginSynthetic({
			onPrompt: async () => "sk-synthetic-test",
		});

		expect(apiKey).toBe("sk-synthetic-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
