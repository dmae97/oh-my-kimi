import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { sakanaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ResolvedOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_ENV = {
	SAKANA_API_KEY: Bun.env.SAKANA_API_KEY,
	FUGU_API_KEY: Bun.env.FUGU_API_KEY,
	SAKANA_BASE_URL: Bun.env.SAKANA_BASE_URL,
	FUGU_BASE_URL: Bun.env.FUGU_BASE_URL,
} as const;

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
	const value = ORIGINAL_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	restoreEnvVar("SAKANA_API_KEY");
	restoreEnvVar("FUGU_API_KEY");
	restoreEnvVar("SAKANA_BASE_URL");
	restoreEnvVar("FUGU_BASE_URL");
	vi.restoreAllMocks();
});

describe("Sakana AI provider support", () => {
	test("resolves Sakana and Fugu API key environment fallbacks", () => {
		delete Bun.env.SAKANA_API_KEY;
		Bun.env.FUGU_API_KEY = "fugu-test-key";
		expect(getEnvApiKey("sakana")).toBe("fugu-test-key");

		Bun.env.SAKANA_API_KEY = "sakana-test-key";
		expect(getEnvApiKey("sakana")).toBe("sakana-test-key");
	});

	test("registers descriptor, default model, bundled Fugu models, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "sakana");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("fugu");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["SAKANA_API_KEY", "FUGU_API_KEY"]);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.sakana).toBe("fugu");

		const bundled = getBundledModels("sakana");
		expect(bundled.map(model => model.id).sort()).toEqual(["fugu", "fugu-ultra", "fugu-ultra-20260615"]);
		for (const model of bundled) {
			expect(model.api).toBe("openai-responses");
			expect(model.thinking?.efforts).toEqual([Effort.High, Effort.XHigh]);
			expect(model.thinking?.effortMap?.[Effort.XHigh]).toBe("max");
			expect((model.compat as ResolvedOpenAIResponsesCompat).includeEncryptedReasoning).toBe(false);
		}

		const provider = getOAuthProviders().find(item => item.id === "sakana");
		expect(provider?.name).toBe("Sakana AI");
	});

	test("discovers models from Sakana Models API with normalized base URL and curated Fugu metadata", async () => {
		delete Bun.env.SAKANA_BASE_URL;
		Bun.env.FUGU_BASE_URL = "https://gateway.sakana.test";
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "fugu" }, { id: "fugu-ultra" }, { id: "fugu-next" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const options = sakanaModelManagerOptions({ apiKey: "sakana-key", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.sakana.test/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer sakana-key" }),
			}),
		);
		expect(models?.map(model => model.id)).toEqual(["fugu", "fugu-next", "fugu-ultra"]);
		const fuguNext = models?.find(model => model.id === "fugu-next");
		expect(fuguNext?.reasoning).toBe(true);
		expect(fuguNext?.thinking?.efforts).toEqual([Effort.High, Effort.XHigh]);
		expect(fuguNext?.thinking?.effortMap?.[Effort.XHigh]).toBe("max");
		expect(fuguNext?.compat?.includeEncryptedReasoning).toBe(false);
	});

	test("prefers explicit Sakana model-manager base URL over environment aliases", async () => {
		Bun.env.SAKANA_BASE_URL = "https://env.sakana.test";
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "fugu" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const options = sakanaModelManagerOptions({
			apiKey: "sakana-key",
			baseUrl: "https://config.sakana.test/api",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://config.sakana.test/api/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});
});
