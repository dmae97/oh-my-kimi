import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { aimlApiModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";

describe("AIML API built-in provider (issue #2105)", () => {
	test("registers built-in runtime descriptor with AIMLAPI_API_KEY discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "aimlapi");

		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("gpt-4o");
		expect(descriptor?.catalogDiscovery?.label).toBe("AIML API");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("AIMLAPI_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.aimlapi).toBe("gpt-4o");
	});

	test("uses the OpenAI-compatible completions transport and AIML API base URL", async () => {
		const previousFetch = global.fetch;
		const calls: Array<{ url: string; authorization: string | null }> = [];
		global.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				calls.push({ url: input.toString(), authorization: headers.get("authorization") });
				return new Response(JSON.stringify({ data: [{ id: "gpt-4o", name: "GPT-4o" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			{ preconnect: previousFetch.preconnect },
		);
		try {
			const options = aimlApiModelManagerOptions({ apiKey: "aiml-test-key" });
			const models = await options.fetchDynamicModels?.();

			expect(options.providerId).toBe("aimlapi");
			expect(calls).toEqual([
				{
					url: "https://api.aimlapi.com/v1/models",
					authorization: "Bearer aiml-test-key",
				},
			]);
			expect(models?.[0]).toMatchObject({
				id: "gpt-4o",
				name: "GPT-4o",
				api: "openai-completions",
				provider: "aimlapi",
				baseUrl: "https://api.aimlapi.com/v1",
			});
		} finally {
			global.fetch = previousFetch;
		}
	});

	test("resolves AIMLAPI_API_KEY via env", () => {
		const previous = Bun.env.AIMLAPI_API_KEY;
		Bun.env.AIMLAPI_API_KEY = "aiml-test-key";
		try {
			expect(getEnvApiKey("aimlapi")).toBe("aiml-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.AIMLAPI_API_KEY;
			} else {
				Bun.env.AIMLAPI_API_KEY = previous;
			}
		}
	});
});
