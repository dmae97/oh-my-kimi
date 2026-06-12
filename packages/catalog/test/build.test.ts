import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
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
