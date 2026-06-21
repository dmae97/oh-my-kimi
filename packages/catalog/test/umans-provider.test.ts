import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	umansModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import modelsJson from "../src/models.json";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number | null;
	maxTokens: number | null;
	thinking?: {
		defaultLevel?: string;
		requiresEffort?: boolean;
		efforts?: string[];
		effortMap?: Record<string, string>;
	};
	compat?: {
		escapeBuiltinToolNames?: boolean;
	};
}

describe("umans provider catalog", () => {
	it("discovers Anthropic-route models from the public models info endpoint", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(String(input));
			return new Response(
				JSON.stringify({
					"umans-coder": {
						display_name: "Umans Coder",
						capabilities: {
							context_window: 262_144,
							max_completion_tokens: 262_144,
							recommended_max_tokens: 32_768,
							supports_vision: true,
							supports_tools: true,
							reasoning: { supported: true, can_disable: true, default_level: "medium" },
						},
					},
					"umans-kimi-k2.7": {
						display_name: "Umans Kimi K2.7 Code",
						capabilities: {
							context_window: 262_144,
							max_completion_tokens: 262_144,
							recommended_max_tokens: 32_768,
							supports_vision: true,
							supports_tools: true,
							reasoning: { supported: true, can_disable: false, default_level: "medium" },
						},
					},
					"umans-glm-5.2": {
						display_name: "Umans GLM 5.2",
						capabilities: {
							context_window: 405_504,
							max_completion_tokens: 131_072,
							recommended_max_tokens: 131_071,
							supports_vision: "via-handoff",
							supports_tools: true,
							reasoning: {
								supported: true,
								can_disable: true,
								levels: ["none", "high", "max"],
								default_level: "high",
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = umansModelManagerOptions({ fetch: fetchImpl });
		const fetchDynamicModels = options.fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Umans dynamic discovery is not configured");

		const models = await fetchDynamicModels();

		expect(requestedUrls).toEqual(["https://api.code.umans.ai/v1/models/info"]);
		expect(models).not.toBeNull();
		const model = models?.find(item => item.id === "umans-coder");
		expect(model).toMatchObject({
			id: "umans-coder",
			name: "Umans Coder",
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262_144,
			maxTokens: 32_768,
			thinking: { defaultLevel: "medium" },
			compat: { escapeBuiltinToolNames: true },
		});
		const mandatoryReasoningModel = models?.find(item => item.id === "umans-kimi-k2.7");
		expect(mandatoryReasoningModel).toMatchObject({
			id: "umans-kimi-k2.7",
			reasoning: true,
			maxTokens: 32_768,
			thinking: { defaultLevel: "medium", requiresEffort: true },
			compat: { escapeBuiltinToolNames: true },
		});
		const glm52 = models?.find(item => item.id === "umans-glm-5.2");
		expect(glm52).toMatchObject({
			id: "umans-glm-5.2",
			reasoning: true,
			thinking: {
				mode: "anthropic-budget-effort",
				defaultLevel: "high",
				efforts: ["high", "xhigh"],
				effortMap: { xhigh: "max" },
			},
		});
		if (!glm52) throw new Error("Umans GLM 5.2 was not discovered");
		expect(glm52.thinking?.effortMap).toEqual({ [Effort.XHigh]: "max" });
		expect(glm52.thinking?.defaultLevel).toBe(Effort.High);
	});

	it("surfaces Umans discovery fetch failures", async () => {
		const fetchDynamicModels = umansModelManagerOptions({
			fetch: async () => {
				throw new Error("boom");
			},
		}).fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Umans dynamic discovery is not configured");

		await expect(fetchDynamicModels()).rejects.toThrow("Failed to fetch Umans models info");
	});

	it("maps the models.dev Umans provider to the Anthropic endpoint", () => {
		const models = mapModelsDevToModels(
			{
				"umans-ai-coding-plan": {
					models: {
						"umans-coder": {
							name: "Umans Coder",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 262_144, output: 262_144 },
							cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						},
					},
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		).filter(model => model.provider === "umans");

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "umans-coder",
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262_144,
			maxTokens: 262_144,
		});
	});

	it("bundles the default Umans coding model", () => {
		const providers = modelsJson as Record<string, Record<string, BundledModel>>;
		const model = providers.umans?.["umans-coder"];

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262_144,
			maxTokens: 32_768,
			compat: { escapeBuiltinToolNames: true },
		});
	});

	it("bundles Umans mandatory reasoning metadata", () => {
		const providers = modelsJson as Record<string, Record<string, BundledModel>>;
		const model = providers.umans?.["umans-kimi-k2.7"];

		expect(model).toBeDefined();
		expect(model.maxTokens).toBe(32_768);
		expect(model.compat?.escapeBuiltinToolNames).toBe(true);
		expect(model.thinking).toMatchObject({
			requiresEffort: true,
		});
	});

	it("bundles Umans GLM 5.2 high/max reasoning metadata with the max wire effort", () => {
		const providers = modelsJson as Record<string, Record<string, BundledModel>>;
		const model = providers.umans?.["umans-glm-5.2"];

		expect(model).toBeDefined();
		expect(model.thinking).toMatchObject({
			mode: "anthropic-budget-effort",
			efforts: ["high", "xhigh"],
			effortMap: { xhigh: "max" },
		});
	});
});
