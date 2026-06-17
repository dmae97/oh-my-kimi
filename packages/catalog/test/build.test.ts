import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { buildOpenAICompat, buildOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function completionsSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function openrouterSpec(overrides: Partial<ModelSpec<"openrouter">> = {}): ModelSpec<"openrouter"> {
	return {
		id: "anthropic/claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		...overrides,
	};
}

describe("buildModel", () => {
	it("resolves a complete compat record for an openai-completions spec with no compat", () => {
		const model = buildModel(completionsSpec());

		expect(model.compat).toBeDefined();
		expect(typeof model.compat.supportsStore).toBe("boolean");
		expect(model.compat.maxTokensField).toBe("max_completion_tokens");
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(typeof model.compat.isOpenRouterHost).toBe("boolean");
		expect(model.compat.isOpenRouterHost).toBe(false);
		expect(model.compatConfig).toBeUndefined();
	});

	it("lets sparse overrides win over detection and keeps the verbatim config", () => {
		const sparse = { supportsDeveloperRole: true } as const;
		const model = buildModel(
			completionsSpec({
				provider: "groq",
				baseUrl: "https://api.groq.com/openai/v1",
				compat: sparse,
			}),
		);

		// Detection would say false for a non-OpenAI host; the override wins.
		expect(model.compat.supportsDeveloperRole).toBe(true);
		// The verbatim sparse object is preserved by reference.
		expect(model.compatConfig).toBe(sparse);
	});

	it("materializes the opencode whenThinking variant without mutating the base view", () => {
		const model = buildModel(
			completionsSpec({
				provider: "opencode-zen",
				baseUrl: "https://opencode.ai/zen/v1",
				reasoning: true,
			}),
		);

		expect(model.compat.whenThinking).toBeDefined();
		expect(model.compat.whenThinking?.requiresReasoningContentForToolCalls).toBe(true);
		expect(model.compat.whenThinking?.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		// Base compat stays on the thinking-off defaults.
		expect(model.compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(model.compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);
	});

	it("leaves whenThinking undefined for non-opencode reasoning specs", () => {
		const model = buildModel(completionsSpec({ reasoning: true }));
		expect(model.compat.whenThinking).toBeUndefined();
	});

	it("builds OpenRouter pseudo-API models with shared chat and Responses compat", () => {
		const model = buildModel(
			openrouterSpec({
				compat: { openRouterRouting: { only: ["anthropic"], order: ["anthropic"] } },
			}),
		);

		expect(model.compat).toBeDefined();
		expect(model.compat.isOpenRouterHost).toBe(true);
		expect(model.compat.thinkingFormat).toBe("openrouter");
		expect(model.compat.supportsStrictMode).toBe(true);
		expect(model.compat.strictResponsesPairing).toBe(false);
		expect(model.compat.openRouterRouting).toEqual({ only: ["anthropic"], order: ["anthropic"] });
	});

	it("loads bundled OpenRouter models with resolved compat", () => {
		const model = getBundledModel<"openrouter">("openrouter", "anthropic/claude-sonnet-4");

		expect(model.compat).toBeDefined();
		expect(model.compat?.isOpenRouterHost).toBe(true);
		expect(model.compat?.supportsStrictMode).toBe(true);
	});

	it("strips gateway author prefixes and extrinsic tags from display names", () => {
		const cases: [string, string][] = [
			["Anthropic: Claude Opus 4.6 (Fast) ($$$$)", "Claude Opus 4.6 (Fast)"],
			["Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
			["Gemini 2.5 Flash (Thinking) (Antigravity)", "Gemini 2.5 Flash (Thinking)"],
			["Stealth: Claude Opus 4.6 (20% off)", "Claude Opus 4.6"],
			["NousResearch: Hermes 2 Pro (retires Jun 5)", "Hermes 2 Pro"],
			["Z.ai: GLM 5", "GLM 5"],
		];
		for (const [raw, cleaned] of cases) {
			expect(buildModel(completionsSpec({ name: raw })).name).toBe(cleaned);
		}
	});

	it("keeps variant tags that map to distinct wire ids", () => {
		const keep = [
			"Trinity Large Preview (free)",
			"Grok 4.1 Fast (Non-Reasoning)",
			"GPT-4o (2024-08-06)",
			"Claude Haiku 3.5 (EU)",
			"Llama-3.3+(3.1v3.3)-70B-Hanami-x1",
		];
		for (const name of keep) {
			expect(buildModel(completionsSpec({ name })).name).toBe(name);
		}
	});
});

describe("openai-completions wire-quirk compat detection", () => {
	it("derives wireModelIdMode from provider/host", () => {
		expect(buildOpenAICompat(completionsSpec({ provider: "firepass" })).wireModelIdMode).toBe("firepass");
		expect(
			buildOpenAICompat(completionsSpec({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }))
				.wireModelIdMode,
		).toBe("fireworks");
		expect(
			buildOpenAICompat(completionsSpec({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }))
				.wireModelIdMode,
		).toBe("openrouter");
		expect(buildOpenAICompat(completionsSpec()).wireModelIdMode).toBe("raw");
	});

	it("strips DeepSeek special tokens only for deepseek ids on nvidia/deepseek providers", () => {
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "nvidia",
					id: "deepseek-ai/deepseek-v3.1",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).stripDeepseekSpecialTokens,
		).toBe(true);
		expect(
			buildOpenAICompat(
				completionsSpec({ provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
			).stripDeepseekSpecialTokens,
		).toBe(true);
		// DeepSeek id behind another host must NOT strip (only nvidia/deepseek hosts emit the raw tokens).
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "openrouter",
					id: "deepseek/deepseek-v3.1",
					baseUrl: "https://openrouter.ai/api/v1",
				}),
			).stripDeepseekSpecialTokens,
		).toBe(false);
		// Non-deepseek id on nvidia must NOT strip.
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "nvidia",
					id: "meta/llama-3.1",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).stripDeepseekSpecialTokens,
		).toBe(false);
	});

	it("flags cumulative reasoning deltas for MiniMax provider or id", () => {
		expect(buildOpenAICompat(completionsSpec({ provider: "minimax" })).reasoningDeltasMayBeCumulative).toBe(true);
		expect(buildOpenAICompat(completionsSpec({ id: "MiniMax-M2" })).reasoningDeltasMayBeCumulative).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).reasoningDeltasMayBeCumulative).toBe(false);
	});

	it("maps the remaining provider-keyed wire quirks", () => {
		expect(buildOpenAICompat(completionsSpec({ provider: "ollama" })).emptyLengthFinishIsContextError).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).emptyLengthFinishIsContextError).toBe(false);
		expect(
			buildOpenAICompat(completionsSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1" }))
				.usesOpenAIToolCallIdLimit,
		).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).usesOpenAIToolCallIdLimit).toBe(false);
		expect(
			buildOpenAICompat(completionsSpec({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }))
				.dropThinkingWhenReasoningEffort,
		).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).dropThinkingWhenReasoningEffort).toBe(false);
	});

	it("derives Responses obfuscation opt-out and wire mode per surface", () => {
		expect(
			buildOpenAIResponsesCompat({
				id: "gpt-5",
				provider: "openai",
				name: "GPT 5",
				baseUrl: "https://api.openai.com/v1",
			}).supportsObfuscationOptOut,
		).toBe(true);
		// Azure mirrors the schema but is NOT the OpenAI host: no obfuscation opt-out.
		expect(
			buildOpenAIResponsesCompat({ id: "gpt-5", provider: "azure", name: "gpt-5", baseUrl: "" })
				.supportsObfuscationOptOut,
		).toBe(false);
		const openrouterResponses = buildOpenAIResponsesCompat({
			id: "anthropic/claude-sonnet-4",
			provider: "openrouter",
			name: "Claude Sonnet 4",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		expect(openrouterResponses.supportsObfuscationOptOut).toBe(false);
		expect(openrouterResponses.wireModelIdMode).toBe("openrouter");
	});
});

describe("model cache spec round trip", () => {
	it("persists sparse specs and rebuilds resolved models on cache reads", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-model-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const sparse = { supportsDeveloperRole: true } as const;
		const spec = completionsSpec({ provider: "spec-cache-test", compat: sparse });
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => [spec],
				},
				"online",
			);
			expect(online.models[0]?.compat.supportsDeveloperRole).toBe(true);

			// The persisted row carries the sparse spec, never the resolved record.
			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ models: string }, [string]>("SELECT models FROM model_cache WHERE provider_id = ?")
				.get("spec-cache-test");
			db.close();
			expect(row).toBeDefined();
			const persisted = JSON.parse(row?.models ?? "[]") as ModelSpec<"openai-completions">[];
			expect(persisted[0]?.compat).toEqual(sparse);
			expect(persisted[0]).not.toHaveProperty("compatConfig");
			expect(persisted[0]?.compat).not.toHaveProperty("isOpenRouterHost");

			// Offline reads rebuild the row into a fully-resolved model.
			const offline = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
				},
				"offline",
			);
			const model = offline.models.find(candidate => candidate.id === spec.id);
			expect(model?.compat.supportsDeveloperRole).toBe(true);
			expect(model?.compat.isOpenRouterHost).toBe(false);
			expect(model?.compatConfig).toEqual(sparse);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("isOfficialAnthropicApiUrl", () => {
	it("treats a missing baseUrl as official", () => {
		expect(isOfficialAnthropicApiUrl(undefined)).toBe(true);
	});

	it("accepts the https first-party host", () => {
		expect(isOfficialAnthropicApiUrl("https://api.anthropic.com/v1")).toBe(true);
	});

	it("rejects non-https schemes", () => {
		expect(isOfficialAnthropicApiUrl("http://api.anthropic.com")).toBe(false);
	});

	it("rejects lookalike hostnames", () => {
		expect(isOfficialAnthropicApiUrl("https://api.anthropic.com.evil.com")).toBe(false);
	});
});
