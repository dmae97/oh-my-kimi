import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

describe("Codex model discovery", () => {
	it("marks discovered models for provider-native V2 compaction", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high", "xhigh"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
					{ headers: { etag: "models-v1" } },
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		expect(result?.etag).toBe("models-v1");
		expect(result?.models).toHaveLength(1);
		expect(result?.models[0]).toMatchObject({
			id: "gpt-5.5",
			provider: "openai-codex",
			api: "openai-codex-responses",
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
			},
		});
	});

	it("carries use_responses_lite and prefer_websockets onto the model spec", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-terra",
								display_name: "GPT-5.6-Terra",
								context_window: 372_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
								prefer_websockets: true,
								use_responses_lite: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		const terra = result?.models.find(model => model.id === "gpt-5.6-terra");
		expect(terra).toMatchObject({ preferWebsockets: true, useResponsesLite: true });
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.useResponsesLite).toBeUndefined();
	});

	it("ignores pre-V2 Codex discovery cache rows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v7-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const cachedModel: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const refreshedModel: ModelSpec<"openai-codex-responses"> = {
			...cachedModel,
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
			},
		};
		try {
			writeModelCache(
				"openai-codex",
				Date.now(),
				[buildModel(cachedModel)],
				true,
				"merge-v3:authoritative:merge-v3:empty",
				dbPath,
			);
			const db = new Database(dbPath);
			try {
				db.run("UPDATE model_cache SET version = 7 WHERE provider_id = ?", ["openai-codex"]);
			} finally {
				db.close();
			}

			let fetched = false;
			const result = await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [refreshedModel];
				},
			});

			expect(fetched).toBe(true);
			expect(result.models.find(model => model.id === "gpt-5.5")?.remoteCompaction).toEqual(
				refreshedModel.remoteCompaction,
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not silently promote legacy v2 Codex cache rows to the current schema", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v2-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			// Seed a v2 row directly, mirroring the shape written by very old
			// installs before schema versioning stabilized. The migration must NOT
			// resurrect it as the current version — that would keep the pre-V2
			// compaction metadata alive across cache-schema bumps.
			const seed = new Database(dbPath, { create: true });
			try {
				seed.run(`
					CREATE TABLE model_cache (
						provider_id TEXT PRIMARY KEY,
						version INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						authoritative INTEGER NOT NULL DEFAULT 0,
						static_fingerprint TEXT NOT NULL DEFAULT '',
						models TEXT NOT NULL
					)
				`);
				seed.run(
					"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, 2, ?, 1, '', '[]')",
					["openai-codex", Date.now()],
				);
			} finally {
				seed.close();
			}

			let fetched = false;
			await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [];
				},
			});
			expect(fetched).toBe(true);

			const inspect = new Database(dbPath, { readonly: true });
			try {
				const row = inspect
					.query<{ version: number }, [string]>("SELECT version FROM model_cache WHERE provider_id = ?")
					.get("openai-codex");
				expect(row?.version).not.toBe(2);
			} finally {
				inspect.close();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
