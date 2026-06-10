import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl, type Model, type OpenAICompat, type ThinkingConfig } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	let originalOllamaBaseUrl: string | undefined;
	let originalOllamaHost: string | undefined;
	let originalOllamaContextLength: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalOllamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
		originalOllamaHost = Bun.env.OLLAMA_HOST;
		originalOllamaContextLength = Bun.env.OLLAMA_CONTEXT_LENGTH;
		delete Bun.env.OLLAMA_BASE_URL;
		delete Bun.env.OLLAMA_HOST;
		delete Bun.env.OLLAMA_CONTEXT_LENGTH;
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		// In-memory auth DB: tests need a fresh, isolated credential store per case but
		// never reopen it from disk, so :memory: avoids the WAL/chmod disk-open cost
		// (~3ms/test) while preserving per-test isolation.
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		if (originalOllamaBaseUrl === undefined) {
			delete Bun.env.OLLAMA_BASE_URL;
		} else {
			Bun.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
		}
		if (originalOllamaHost === undefined) {
			delete Bun.env.OLLAMA_HOST;
		} else {
			Bun.env.OLLAMA_HOST = originalOllamaHost;
		}
		if (originalOllamaContextLength === undefined) {
			delete Bun.env.OLLAMA_CONTEXT_LENGTH;
		} else {
			Bun.env.OLLAMA_CONTEXT_LENGTH = originalOllamaContextLength;
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	type ProviderConfig = {
		baseUrl: string;
		apiKey: string;
		api: string;
		models: Array<{
			id: string;
			name: string;
			reasoning: boolean;
			thinking?: ThinkingConfig;
			input: string[];
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
			contextWindow: number;
			maxTokens: number;
		}>;
	};

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			thinking?: ThinkingConfig;
			contextWindow?: number;
		}>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map(m => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				thinking: m.thinking,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ProviderConfig>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	function getOpenAICompat(model: Model | undefined): OpenAICompat | undefined {
		// All custom-model compat overrides flow through OpenAICompatSchema regardless of
		// the underlying api ("openai-completions" vs "openai-responses"), so we can read
		// the configured (sparse) compat for any model in this fixture.
		return model?.compatConfig as OpenAICompat | undefined;
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function writeRawModelsConfig(config: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify(config));
	}

	function mockOpenAiCompatibleModels(url: string, modelIds: string[]): FetchImpl {
		return async input => {
			const requestUrl = String(input);
			if (requestUrl === url) {
				return new Response(JSON.stringify({ data: modelIds.map(id => ({ id })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${requestUrl}`);
		};
	}

	describe("canonical equivalence", () => {
		test("groups dotted provider variants under the bundled canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(variants.some(variant => variant.selector === "anthropic/claude-sonnet-4-5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("collapses wrapped, dated, and tuned anthropic variants under the base canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-opus-4.5" },
					{ id: "claude-opus-4-5-20251101" },
					{ id: "claude-4.5-opus-high-thinking" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-opus-4-5");

			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-opus-4.5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-opus-4-5-20251101")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-4.5-opus-high-thinking")).toBe(true);
		});

		test("collapses gitlab duo chat wrapper ids into the upstream canonical id", () => {
			writeRawModelsJson({
				"gitlab-duo": providerConfig("https://demo.example.com/v1", [{ id: "duo-chat-opus-4-6" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-opus-4-6");

			expect(variants.some(variant => variant.selector === "gitlab-duo/duo-chat-opus-4-6")).toBe(true);
		});

		test("collapses synthetic and vendor-prefixed glm wrappers into the upstream canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "hf:zai-org/GLM-4.7" }, { id: "zai-glm-4.7" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("glm-4.7");

			expect(variants.some(variant => variant.selector === "demo/hf:zai-org/GLM-4.7")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/zai-glm-4.7")).toBe(true);
		});

		test("collapses compact and reordered claude aliases into the upstream canonical id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "claude-opus-45" },
					{ id: "claude-4.5-sonnet" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const opusVariants = registry.getCanonicalVariants("claude-opus-4-5");
			const sonnetVariants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(opusVariants.some(variant => variant.selector === "demo/claude-opus-45")).toBe(true);
			expect(sonnetVariants.some(variant => variant.selector === "demo/claude-4.5-sonnet")).toBe(true);
		});

		test("collapses nitro-suffixed OpenRouter variants under the upstream canonical id", () => {
			writeRawModelsJson({
				openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7-20251222:nitro" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("glm-4.7");

			expect(variants.some(variant => variant.selector === "openrouter/z-ai/glm-4.7-20251222:nitro")).toBe(true);
		});

		test("keeps Perplexity search canonical distinct from non-search Sonar Pro ids", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "perplexity/sonar-pro-search" },
					{ id: "perplexity/sonar-pro" },
					{ id: "sonar-pro" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const searchModel = registry.find("demo", "perplexity/sonar-pro-search");
			const proModel = registry.find("demo", "perplexity/sonar-pro");
			const bareModel = registry.find("demo", "sonar-pro");
			if (!searchModel || !proModel || !bareModel) {
				throw new Error("Perplexity canonical equivalence fixture models were not registered");
			}

			const searchCanonicalId = registry.getCanonicalId(searchModel);
			expect(searchCanonicalId).toBe("perplexity/sonar-pro-search");
			expect(searchCanonicalId).not.toBe(registry.getCanonicalId(proModel));
			expect(searchCanonicalId).not.toBe(registry.getCanonicalId(bareModel));
			expect(
				registry
					.getCanonicalVariants("perplexity/sonar-pro-search")
					.some(variant => variant.selector === "demo/perplexity/sonar-pro"),
			).toBe(false);
			expect(
				registry
					.getCanonicalVariants("perplexity/sonar-pro-search")
					.some(variant => variant.selector === "demo/sonar-pro"),
			).toBe(false);
		});

		test("uses bundled metadata for Ollama cloud aliases in custom local-proxy configs", () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					models: [
						{
							id: "deepseek-v4-pro:cloud",
							name: "DeepSeek V4 Pro (Ollama Cloud)",
							reasoning: true,
							input: ["text"],
							contextWindow: 1_048_576,
							maxTokens: 65_536,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("ollama", "deepseek-v4-pro:cloud");
			const variants = registry.getCanonicalVariants("deepseek-v4-pro");

			expect(model?.cost.cacheRead).toBeGreaterThan(0);
			expect(model?.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
			expect(variants.some(variant => variant.selector === "ollama/deepseek-v4-pro:cloud")).toBe(true);
		});

		test("collapses anthropic latest aliases into the best upstream claude family id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "anthropic/claude-opus-latest" },
					{ id: "anthropic/claude-haiku-latest" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const opusVariants = registry.getCanonicalVariants("claude-opus-4-8");
			const haikuVariants = registry.getCanonicalVariants("claude-haiku-4-5");

			expect(opusVariants.some(variant => variant.selector === "demo/anthropic/claude-opus-latest")).toBe(true);
			expect(haikuVariants.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest")).toBe(true);
			expect(
				registry
					.getCanonicalVariants("claude-haiku-4-5-20251001-thinking")
					.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest"),
			).toBe(false);
		});

		test("collapses wrapped gemini tool and tuning variants under the base preview id", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "google/gemini-3.1-pro-preview" },
					{ id: "google/gemini-3.1-pro-preview-customtools" },
					{ id: "google/gemini-3.1-pro-preview-high" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("gemini-3.1-pro-preview");

			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-customtools")).toBe(
				true,
			);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-high")).toBe(true);
		});

		test("collapses compact version aliases and hardware suffixes into clean canonical ids", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "hf:nvidia/Kimi-K2.5-NVFP4" },
					{ id: "kimi-k2-5" },
					{ id: "z-ai/glm4.7" },
					{ id: "z-ai/glm5" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const kimiVariants = registry.getCanonicalVariants("kimi-k2.5");
			const glm47Variants = registry.getCanonicalVariants("glm-4.7");
			const glm5Variants = registry.getCanonicalVariants("glm-5");

			expect(kimiVariants.some(variant => variant.selector === "demo/hf:nvidia/Kimi-K2.5-NVFP4")).toBe(true);
			expect(kimiVariants.some(variant => variant.selector === "demo/kimi-k2-5")).toBe(true);
			expect(glm47Variants.some(variant => variant.selector === "demo/z-ai/glm4.7")).toBe(true);
			expect(glm5Variants.some(variant => variant.selector === "demo/z-ai/glm5")).toBe(true);
		});

		test("prefers clean canonical ids over bundled wrapper ids when available", () => {
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [
					{ id: "zai/glm-4.6v-flash" },
					{ id: "hf:deepseek-ai/DeepSeek-V3" },
					{ id: "google/gemini-pro-latest" },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(
				registry
					.getCanonicalVariants("glm-4.6v-flash")
					.some(variant => variant.selector === "demo/zai/glm-4.6v-flash"),
			).toBe(true);
			expect(
				registry
					.getCanonicalVariants("deepseek-v3")
					.some(variant => variant.selector === "demo/hf:deepseek-ai/DeepSeek-V3"),
			).toBe(true);
			expect(
				registry
					.getCanonicalVariants("gemini-pro")
					.some(variant => variant.selector === "demo/google/gemini-pro-latest"),
			).toBe(true);
		});

		test("applies explicit equivalence overrides from config", () => {
			writeRawModelsConfig({
				providers: {
					"proxy-anthropic": providerConfig("https://demo.example.com/v1", [{ id: "corp-sonnet" }]),
				},
				equivalence: {
					overrides: {
						"proxy-anthropic/corp-sonnet": "claude-sonnet-4-5",
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const variants = registry.getCanonicalVariants("claude-sonnet-4-5");

			expect(variants.some(variant => variant.selector === "proxy-anthropic/corp-sonnet")).toBe(true);
		});

		test("exclusions keep variants out of canonical grouping", () => {
			writeRawModelsConfig({
				providers: {
					demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				},
				equivalence: {
					exclude: ["demo/anthropic/claude-sonnet-4.5"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const grouped = registry.getCanonicalVariants("claude-sonnet-4-5");
			const fallback = registry.getCanonicalVariants("anthropic/claude-sonnet-4.5");

			expect(grouped.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(false);
			expect(fallback.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("resolves canonical models using configured provider order", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					modelProviderOrder: ["demo", "anthropic"],
				},
			});
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
			});

			expect(resolved?.provider).toBe("demo");
			expect(resolved?.id).toBe("anthropic/claude-sonnet-4.5");
		});

		test("getCanonicalModelSelections matches per-record resolveCanonicalModel over the bundled catalog", () => {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			authStorage.setRuntimeApiKey("openrouter", "test-key");
			authStorage.setRuntimeApiKey("groq", "test-key");
			writeModelsJson({});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const candidates = registry.getAvailable();
			expect(candidates.length).toBeGreaterThan(0);

			const options = { availableOnly: true, candidates } as const;
			const selections = registry.getCanonicalModelSelections(options);
			const records = registry.getCanonicalModels(options);
			expect(selections.length).toBe(records.length);
			expect(selections.length).toBeGreaterThan(0);

			const mismatches = selections
				.map(({ record, model }) => {
					const resolved = registry.resolveCanonicalModel(record.id, options);
					return resolved && resolved.provider === model.provider && resolved.id === model.id
						? undefined
						: `${record.id}: batch=${model.provider}/${model.id} loop=${resolved?.provider}/${resolved?.id}`;
				})
				.filter((entry): entry is string => entry !== undefined);
			expect(mismatches).toEqual([]);
		});
	});

	describe("OpenRouter routed suffix fallback", () => {
		test("find synthesizes a routed model id from the base OpenRouter metadata", () => {
			writeRawModelsJson({
				openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openrouter", "z-ai/glm-4.7-20251222:nitro");

			expect(model?.provider).toBe("openrouter");
			expect(model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(model?.name).toBe("z-ai/glm-4.7-20251222:nitro");
		});
	});

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers merges with model headers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("headers-only override applies to built-in models", () => {
			writeRawModelsJson({
				anthropic: {
					headers: { "X-Custom-Header": "custom-only" },
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-only");
			}
		});

		test("authHeader override applies bearer auth to built-in models without custom models", () => {
			writeRawModelsJson({
				anthropic: {
					baseUrl: "https://anthropic-proxy.example.com/v1",
					apiKey: "issue-929-key",
					authHeader: true,
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			for (const model of anthropicModels) {
				expect(model.headers?.Authorization).toBe("Bearer issue-929-key");
			}
		});

		test("apiKey-only override supplies fallback auth for built-in models", async () => {
			const originalOpenAiKey = Bun.env.OPENAI_API_KEY;
			delete Bun.env.OPENAI_API_KEY;
			try {
				writeRawModelsJson({
					openai: {
						apiKey: "issue-typed-key",
					},
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");

				expect(openaiModels.length).toBeGreaterThan(0);
				await expect(registry.getApiKey(openaiModels[0])).resolves.toBe("issue-typed-key");
			} finally {
				if (originalOpenAiKey === undefined) delete Bun.env.OPENAI_API_KEY;
				else Bun.env.OPENAI_API_KEY = originalOpenAiKey;
			}
		});
		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some(m => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			await registry.refresh("offline");

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("provider compat overrides", () => {
		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
						supportsMultipleSystemMessages: false,
						disableReasoningOnToolChoice: true,
						allowsSyntheticReasoningContentForToolCalls: false,
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(getOpenAICompat(model)?.supportsUsageInStreaming).toBe(false);
				expect(getOpenAICompat(model)?.supportsStrictMode).toBe(false);
				expect(getOpenAICompat(model)?.supportsMultipleSystemMessages).toBe(false);
				expect(getOpenAICompat(model)?.disableReasoningOnToolChoice).toBe(true);
				expect(getOpenAICompat(model)?.allowsSyntheticReasoningContentForToolCalls).toBe(false);
			}
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
						cacheControlFormat: "anthropic",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});
	});

	describe("custom models merge behavior", () => {
		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Built-in models still present, custom model merged in
			expect(anthropicModels.length).toBeGreaterThan(1);
			const custom = anthropicModels.find(m => m.id === "claude-custom");
			expect(custom).toBeDefined();
			expect(custom!.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnetModels = models.filter(m => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom same-id replacement does not keep bundled headers", () => {
			writeRawModelsJson({
				"github-copilot": {
					baseUrl: "https://proxy.example.com/v1",
					headers: { "X-Proxy": "proxy" },
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [{ id: "gpt-4o" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");

			expect(model?.headers).toEqual({ "X-Proxy": "proxy" });
			expect(model?.headers?.["User-Agent"]).toBeUndefined();
			expect(model?.headers?.["Editor-Version"]).toBeUndefined();
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENROUTER_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/openrouter-model",
							name: "Custom OpenRouter Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.some(m => m.id === "custom/openrouter-model")).toBe(true);
			expect(models.some(m => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet")).toBe(
				true,
			);
		});

		test("refresh() reloads merged custom models from disk", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("built-in gpt-5.4 applies the hardcoded context window policy", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(1_000_000);
		});

		test("custom gpt-5.4 replacement keeps the hardcoded context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openai", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom-only gpt-5.4 provider keeps the hardcoded context window when contextWindow is omitted", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [{ id: "gpt-5.4" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("my-proxy", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom gpt-5.4 replacement preserves its explicit context window", () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);
		});

		test("modelOverrides can still patch a custom gpt-5.4 replacement", () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							name: "gpt-5.4",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 256000,
							maxTokens: 128000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("discoverable bundled replacement survives refresh", async () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", name: "Proxy GPT-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});
			const fetchMock = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("openai", "gpt-5.4")?.name).toBe("Proxy GPT-5.4");
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);

			await registry.refreshProvider("openai", "online");

			const model = registry.find("openai", "gpt-5.4");
			expect(model?.name).toBe("Proxy GPT-5.4");
			expect(model?.contextWindow).toBe(256000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("discoverable custom-only gpt-5.4 survives refresh", async () => {
			writeRawModelsJson({
				"custom-local": {
					baseUrl: "http://127.0.0.1:8080",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					discovery: { type: "llama.cpp" },
					models: [{ id: "gpt-5.4" }],
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("http://127.0.0.1:8080/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("custom-local", "gpt-5.4")?.contextWindow).toBe(1_000_000);

			await registry.refreshProvider("custom-local", "online");

			const model = registry.find("custom-local", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("http://127.0.0.1:8080");
		});

		test("discoverable custom compat survives refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							compat: {
								extraBody: { source: "proxy" },
							},
						},
					],
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(getOpenAICompat(registry.find("openai", "gpt-5.4"))?.extraBody).toEqual({ source: "proxy" });

			await registry.refreshProvider("openai", "online");

			expect(getOpenAICompat(registry.find("openai", "gpt-5.4"))?.extraBody).toEqual({ source: "proxy" });
		});

		test("modelOverrides still apply after discoverable refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							contextWindow: 256000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);

			await registry.refreshProvider("openai", "online");

			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("newly discovered ids inherit provider fields, not another model's custom fields", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://provider.example.com/v1",
					headers: { "X-Provider": "provider" },
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							baseUrl: "https://special.example.com/v1",
							headers: { "X-Model": "special" },
						},
					],
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("https://provider.example.com/v1/models", ["gpt-5.4", "gpt-5.5"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://special.example.com/v1");

			await registry.refreshProvider("openai", "online");

			const discovered = registry.find("openai", "gpt-5.5");
			expect(discovered?.baseUrl).toBe("https://provider.example.com/v1");
			expect(discovered?.headers?.["X-Provider"]).toBe("provider");
			expect(discovered?.headers?.["X-Model"]).toBeUndefined();
		});

		test("same-id replacement uses configured compat without bundled compat leak", () => {
			writeRawModelsJson({
				"minimax-code": {
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					compat: {
						extraBody: { source: "proxy" },
					},
					models: [{ id: "MiniMax-M2.5" }],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("minimax-code", "MiniMax-M2.5");
			const compat = getOpenAICompat(model);
			expect(compat?.thinkingFormat).toBeUndefined();
			expect(compat?.reasoningContentField).toBeUndefined();
			expect(compat?.extraBody).toEqual({ source: "proxy" });
		});

		test("removing custom models from models.json keeps built-in provider models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("thinking metadata normalization", () => {
		test("custom models preserve explicit thinking and gain backfilled wire facts", () => {
			const thinking: ThinkingConfig = {
				mode: "anthropic-adaptive",
				efforts: [Effort.Minimal, Effort.High],
			};

			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [
					{ id: "claude-custom", reasoning: true, thinking },
				]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = getModelsForProvider(registry, "anthropic").find(m => m.id === "claude-custom");

			expect(model?.thinking).toEqual({
				...thinking,
				// Versionless claude ids resolve to the 4-tier adaptive wire map.
				effortMap: { minimal: "low", xhigh: "max" },
			});
		});

		test("model overrides can replace canonical thinking metadata", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium] },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4");

			expect(model?.thinking).toEqual({
				mode: "budget",
				efforts: [Effort.Low, Effort.Medium],
			});
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("model override merges compat.extraBody across provider+model", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						extraBody: {
							gateway: "default-gateway",
							controller: "provider-controller",
						},
					},
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								extraBody: {
									controller: "model-controller",
								},
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.extraBody).toEqual({ gateway: "default-gateway", controller: "model-controller" });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");

			const sonnetCompat = sonnet?.compat as OpenAICompat | undefined;
			const opusCompat = opus?.compat as OpenAICompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find(m => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");

			expect(sonnet?.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			await registry.refresh("offline");

			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			await registry.refresh("offline");

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});

		test("modelOverrides can set omitMaxOutputTokens on a built-in model", () => {
			writeRawModelsJson({
				openai: {
					modelOverrides: {
						"gpt-5.4": {
							omitMaxOutputTokens: true,
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("openai", "gpt-5.4");
			expect(model?.omitMaxOutputTokens).toBe(true);
			// maxTokens is still populated locally — only the wire emission is suppressed.
			expect(model?.maxTokens).toBeGreaterThan(0);
		});

		test("custom model definitions accept omitMaxOutputTokens", () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://localhost:11434/v1",
					api: "openai-responses",
					auth: "none",
					models: [
						{
							id: "glm-5.1:cloud",
							name: "GLM 5.1 Cloud (Ollama)",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 202752,
							maxTokens: 202752,
							omitMaxOutputTokens: true,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("ollama", "glm-5.1:cloud");
			expect(model?.omitMaxOutputTokens).toBe(true);
			expect(model?.maxTokens).toBe(202752);
		});
	});

	describe("github-copilot oauth endpoint alignment", () => {
		test("getApiKey does not mutate bundled github-copilot baseUrl", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_individual_token_123",
					refresh: "ghu_individual_token_123",
					expires: Date.now() + 60_000,
				},
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");
			expect(model).toBeDefined();
			if (!model) throw new Error("Expected github-copilot/gpt-4o model");

			const initialBaseUrl = model.baseUrl;
			const firstApiKey = await registry.getApiKey(model);
			expect(firstApiKey).toBeDefined();
			const firstParsed = JSON.parse(firstApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(firstParsed.token).toBe("ghu_individual_token_123");
			expect(firstParsed.enterpriseUrl).toBeUndefined();
			const secondApiKey = await registry.getApiKey(model);
			expect(secondApiKey).toBeDefined();
			const secondParsed = JSON.parse(secondApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(secondParsed.token).toBe("ghu_enterprise_token_456");
			expect(secondParsed.enterpriseUrl).toBe("ghe.example.com");
			expect(model.baseUrl).toBe(initialBaseUrl);
		});

		test("refreshProvider uses enterprise Copilot discovery host for peeked credentials", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const requestedUrls: string[] = [];
			const fetchMock: FetchImpl = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				if (url === "https://copilot-api.ghe.example.com/models") {
					const authHeader =
						input instanceof Request
							? input.headers.get("Authorization")
							: new Headers(init?.headers).get("Authorization");
					expect(authHeader).toBe("Bearer ghu_enterprise_token_456");
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "gpt-5-mini",
									name: "GPT-5 mini",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refreshProvider("github-copilot", "online");
			expect(requestedUrls).toContain("https://copilot-api.ghe.example.com/models");
			expect(requestedUrls).not.toContain("https://api.githubcopilot.com/models");
		});
	});

	describe("disabled provider filtering", () => {
		test("getAvailable and getDiscoverableProviders exclude disabled providers from settings", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_test_token_for_disabled",
					refresh: "ghu_test_token_for_disabled",
					expires: Date.now() + 60_000,
				},
			]);
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["github-copilot", "ollama"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getAvailable().some(model => model.provider === "github-copilot")).toBe(false);
			expect(registry.getDiscoverableProviders()).not.toContain("ollama");
		});

		test("refresh skips discovery probes for disabled local providers", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["llama.cpp", "lm-studio", "ollama"],
				},
			});
			const requestedUrls: string[] = [];
			const fetchMock: FetchImpl = input => {
				requestedUrls.push(String(input));
				throw new Error(`Unexpected URL: ${String(input)}`);
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refresh("online");

			const disabledProbeUrls = requestedUrls.filter(
				url => url.includes("127.0.0.1:11434") || url.includes("127.0.0.1:8080") || url.includes("127.0.0.1:1234"),
			);
			expect(disabledProbeUrls).toEqual([]);
		});
	});
	describe("bundled Anthropic catalog availability", () => {
		test("includes native Opus 4.7 in available models when Anthropic auth exists", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "sk-ant-api-test" }]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			expect(
				registry.getAvailable().some(model => model.provider === "anthropic" && model.id === "claude-opus-4-7"),
			).toBe(true);
		});
	});
	describe("disableStrictTools", () => {
		test("custom provider with models gets disableStrictTools merged into compat", () => {
			writeRawModelsJson({
				"bedrock-anthropic": {
					baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					disableStrictTools: true,
					models: [
						{
							id: "claude-sonnet-4-20250514",
							name: "Claude Sonnet 4",
							reasoning: false,
							input: ["text", "image"],
							cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
							contextWindow: 200000,
							maxTokens: 16384,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("bedrock-anthropic", "claude-sonnet-4-20250514");

			expect(model).toBeDefined();
			expect((model?.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
		});

		test("disableStrictTools on override-only provider applies to built-in models", () => {
			writeRawModelsJson({ anthropic: { disableStrictTools: true } });

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "anthropic");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect((model.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
			}
		});

		test("disableStrictTools is absent on built-in models without override", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "anthropic");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(
					(model.compatConfig as { disableStrictTools?: boolean } | undefined)?.disableStrictTools,
				).toBeUndefined();
			}
		});

		test("disableStrictTools is merged with explicit compat on custom provider", () => {
			writeRawModelsJson({
				"my-proxy": {
					baseUrl: "https://proxy.example.com/anthropic",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					disableStrictTools: true,
					models: [
						{
							id: "claude-sonnet-4",
							name: "Sonnet",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 16384,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("my-proxy", "claude-sonnet-4");

			expect(model).toBeDefined();
			expect((model?.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
		});
	});

	describe("provider auth: oauth", () => {
		test("models from a provider with auth: oauth are marked isOAuth=true", async () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com",
					apiKey: "literal-key",
					api: "anthropic-messages",
					auth: "oauth",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-anthropic", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBe(true);
		});

		test("anthropic-messages providers default to isOAuth=true even without explicit auth", async () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com",
					apiKey: "literal-key",
					api: "anthropic-messages",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-anthropic", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBe(true);
		});

		test("auth: apiKey opts out of the anthropic-messages default", async () => {
			writeRawModelsJson({
				"proxy-anthropic": {
					baseUrl: "https://proxy.example.com",
					apiKey: "literal-key",
					api: "anthropic-messages",
					auth: "apiKey",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-anthropic", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBeUndefined();
		});

		test("non-anthropic apis do not get the OAuth default", async () => {
			writeRawModelsJson({
				"proxy-openai": {
					baseUrl: "https://proxy.example.com/v1",
					apiKey: "literal-key",
					api: "openai-completions",
					models: [
						{
							id: "gpt-5",
							name: "GPT-5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8000,
						},
					],
				},
			});
			await authStorage.setRuntimeApiKey("proxy-openai", "literal-key");

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			const model = registry.find("proxy-openai", "gpt-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBeUndefined();
		});
	});

	test("cached discovery with UNK contextWindow preserves bundled value", () => {
		// Configure openai as a discoverable provider through models.json
		writeRawModelsJson({
			openai: {
				baseUrl: "https://my-proxy.example.com/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				discovery: { type: "openai-models-list" },
				models: [],
			},
		});
		// Pre-populate the cache with a model that has UNK sentinel values
		// (simulating a discovery that didn't return limit.context)
		writeModelCache<"openai-completions">(
			"openai",
			Date.now(),
			[
				buildModel({
					id: "gpt-4o",
					name: "GPT-4o",
					api: "openai-completions",
					provider: "openai",
					baseUrl: "https://my-proxy.example.com/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 222_222, // UNK_CONTEXT_WINDOW
					maxTokens: 8_888, // UNK_MAX_TOKENS
				}),
			],
			true,
			cacheDbPath,
		);
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("openai", "gpt-4o");

		expect(model).toBeDefined();
		// The bundled gpt-4o has a correct contextWindow, not the UNK sentinel
		expect(model!.contextWindow).not.toBe(222_222);
		expect(model!.contextWindow).toBeGreaterThan(100_000);
		expect(model!.maxTokens).not.toBe(8_888);
		expect(model!.maxTokens).toBeGreaterThan(1000);
	});

	test("loads cached standard provider discovery models on startup", () => {
		const cachedModel: Model<"ollama-chat"> = buildModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		writeModelCache("ollama-cloud", Date.now(), [cachedModel], true, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		expect(registry.find("ollama-cloud", "deepseek-v4-pro")?.maxTokens).toBe(384_000);
	});

	test("loads cached special provider discovery models on startup", () => {
		const cachedModels: Model[] = [
			buildModel({
				id: "gemini-3.5-flash-low",
				name: "Gemini 3.5 Flash Low",
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: "https://cloudcode-pa.googleapis.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 8_192,
			}),
			buildModel({
				id: "gemini-3.5-flash",
				name: "Gemini 3.5 Flash",
				api: "google-gemini-cli",
				provider: "google-gemini-cli",
				baseUrl: "https://cloudcode-pa.googleapis.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 16_384,
			}),
			buildModel({
				id: "gpt-5.4-codex-pro",
				name: "GPT-5.4 Codex Pro",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 128_000,
			}),
		];
		for (const cachedModel of cachedModels) {
			writeModelCache(cachedModel.provider, Date.now(), [cachedModel], true, "", cacheDbPath);
		}

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		expect(registry.find("google-antigravity", "gemini-3.5-flash-low")?.maxTokens).toBe(8_192);
		expect(registry.find("google-gemini-cli", "gemini-3.5-flash")?.maxTokens).toBe(16_384);
		expect(registry.find("openai-codex", "gpt-5.4-codex-pro")?.maxTokens).toBe(128_000);
	});

	test("replaces bundled google-vertex models with authoritative Vertex project discovery", () => {
		const cachedModel: Model<"openai-completions"> = buildModel({
			id: "zai-org/glm-4.7-maas",
			name: "GLM-4.7",
			api: "openai-completions",
			provider: "google-vertex",
			baseUrl: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 222_222,
			maxTokens: 8_888,
		});
		writeModelCache("google-vertex", Date.now(), [cachedModel], true, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const vertexModels = getModelsForProvider(registry, "google-vertex");

		expect(vertexModels.map(model => model.id)).toEqual(["zai-org/glm-4.7-maas"]);
		expect(registry.find("google-vertex", "gemini-1.5-pro")).toBeUndefined();
	});

	test("does not re-add bundled synthetic models after authoritative cache load", () => {
		const cachedModel: Model<"openai-completions"> = buildModel({
			id: "hf:zai-org/GLM-5.1",
			name: "GLM 5.1",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://api.synthetic.new/openai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		writeModelCache("synthetic", Date.now(), [cachedModel], true, "authoritative:test", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const syntheticModels = getModelsForProvider(registry, "synthetic");

		expect(syntheticModels.map(model => model.id)).toEqual(["hf:zai-org/GLM-5.1"]);
		expect(registry.find("synthetic", "hf:moonshotai/Kimi-K2.5")).toBeUndefined();
	});

	test("does not re-add bundled synthetic models after authoritative refresh", async () => {
		authStorage.setRuntimeApiKey("synthetic", "synthetic-test-key");
		const fetchMock = mockOpenAiCompatibleModels("https://api.synthetic.new/openai/v1/models", [
			"hf:zai-org/GLM-5.1",
		]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		await registry.refresh("online");
		const syntheticModels = getModelsForProvider(registry, "synthetic");

		expect(syntheticModels.map(model => model.id)).toEqual(["hf:zai-org/GLM-5.1"]);
		expect(registry.find("synthetic", "hf:moonshotai/Kimi-K2.5")).toBeUndefined();
	});

	test("keeps bundled google-vertex fallback when cached project catalog is non-authoritative", () => {
		const cachedModel: Model<"openai-completions"> = buildModel({
			id: "zai-org/glm-4.7-maas",
			name: "GLM-4.7",
			api: "openai-completions",
			provider: "google-vertex",
			baseUrl: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 222_222,
			maxTokens: 8_888,
		});
		writeModelCache("google-vertex", Date.now(), [cachedModel], false, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const vertexModels = getModelsForProvider(registry, "google-vertex");

		expect(vertexModels.some(model => model.id === "zai-org/glm-4.7-maas")).toBe(true);
		expect(vertexModels.some(model => model.id.startsWith("gemini-"))).toBe(true);
	});

	test("keeps bundled google-vertex fallback when cached project catalog is stale", () => {
		const cachedModel: Model<"openai-completions"> = buildModel({
			id: "zai-org/glm-4.7-maas",
			name: "GLM-4.7",
			api: "openai-completions",
			provider: "google-vertex",
			baseUrl: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 222_222,
			maxTokens: 8_888,
		});
		// 25h old > 24h TTL → cache.fresh === false even though authoritative === true.
		const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;
		writeModelCache("google-vertex", staleTimestamp, [cachedModel], true, "", cacheDbPath);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const vertexModels = getModelsForProvider(registry, "google-vertex");

		expect(vertexModels.some(model => model.id === "zai-org/glm-4.7-maas")).toBe(true);
		expect(vertexModels.some(model => model.id.startsWith("gemini-"))).toBe(true);
	});
});
