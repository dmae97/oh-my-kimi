import { afterEach, describe, expect, test, vi } from "bun:test";
import { litellmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_LITELLM_BASE_URL = Bun.env.LITELLM_BASE_URL;
const MODELS_DEV_URL = "https://models.dev/api.json";

function restoreLiteLLMBaseUrl(): void {
	if (ORIGINAL_LITELLM_BASE_URL === undefined) {
		delete Bun.env.LITELLM_BASE_URL;
		return;
	}
	Bun.env.LITELLM_BASE_URL = ORIGINAL_LITELLM_BASE_URL;
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function makeFetchMock(expectedModelUrl: string): FetchImpl {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return new Response("{}", { status: 500 });
		}

		expect(url).toBe(expectedModelUrl);
		expect(init?.method).toBe("GET");
		expect(init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer sk-litellm-test",
		});
		return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as FetchImpl;
}

function makeCollisionFetchMock(): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return Response.json({
				"ollama-cloud": {
					models: {
						"deepseek-v4-flash": {
							name: "DeepSeek V4 Flash",
							tool_call: true,
							limit: { context: 64_000, output: 8_000 },
							cost: { input: 1, output: 2 },
						},
					},
				},
			});
		}

		expect(url).toBe("http://primary:4000/v1/models");
		return Response.json({ data: [{ id: "deepseek-v4-flash" }] });
	}) as FetchImpl;
}

afterEach(() => {
	restoreLiteLLMBaseUrl();
	vi.restoreAllMocks();
});

describe("LiteLLM provider discovery", () => {
	test("uses LITELLM_BASE_URL when no explicit baseUrl is configured", async () => {
		Bun.env.LITELLM_BASE_URL = "http://litellm.example:4100/v1";
		const fetchMock = makeFetchMock("http://litellm.example:4100/v1/models");

		const options = litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(options.cacheProviderId).toBe(`litellm:${Bun.hash("http://litellm.example:4100/v1").toString(36)}`);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "openai/gpt-5",
			provider: "litellm",
			baseUrl: "http://litellm.example:4100/v1",
		});
	});

	test("keeps explicit baseUrl higher precedence than LITELLM_BASE_URL", async () => {
		Bun.env.LITELLM_BASE_URL = "http://litellm-env.example:4100/v1";
		const fetchMock = makeFetchMock("http://litellm-config.example:4200/v1/models");

		const options = litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			baseUrl: "http://litellm-config.example:4200/v1/",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(options.cacheProviderId).toBe(
			`litellm:${Bun.hash("http://litellm-config.example:4200/v1/").toString(36)}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(models).toHaveLength(1);
		expect(models?.[0]?.baseUrl).toBe("http://litellm-config.example:4200/v1");
	});

	test("keeps LiteLLM transport when models.dev has a colliding provider model id", async () => {
		const fetchMock = makeCollisionFetchMock();

		const options = litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
			contextWindow: 64_000,
			maxTokens: 8_000,
			cost: {
				input: 1,
				output: 2,
			},
		});
	});
});
