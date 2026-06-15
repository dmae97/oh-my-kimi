import { describe, expect, it } from "bun:test";
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
							supports_vision: true,
							supports_tools: true,
							reasoning: { supported: true, can_disable: false, default_level: "medium" },
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
			maxTokens: 262_144,
			thinking: { defaultLevel: "medium" },
		});
		const mandatoryReasoningModel = models?.find(item => item.id === "umans-kimi-k2.7");
		expect(mandatoryReasoningModel).toMatchObject({
			id: "umans-kimi-k2.7",
			reasoning: true,
			thinking: { defaultLevel: "medium", requiresEffort: true },
		});
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
			maxTokens: 262_144,
		});
	});

	it("bundles Umans mandatory reasoning metadata", () => {
		const providers = modelsJson as Record<string, Record<string, BundledModel>>;
		const model = providers.umans?.["umans-kimi-k2.7"];

		expect(model).toBeDefined();
		expect(model.thinking).toMatchObject({
			requiresEffort: true,
		});
	});
});
