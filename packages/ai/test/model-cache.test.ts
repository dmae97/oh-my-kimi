import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { removeWithRetries } from "../../utils/src/temp";

const TTL_MS = 24 * 60 * 60 * 1000;

function createModel(id: string, name: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 4096,
		maxTokens: 1024,
	});
}

describe("model cache migrations", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("invalidates legacy cached models and lets the next discovery write fresh ones", () => {
		const legacyModel = createModel("legacy-cloud-model", "Legacy Cloud Model");
		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		legacyDb.run(
			"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, models) VALUES (?, ?, ?, ?, ?)",
			["ollama-cloud", 2, Date.now(), 1, JSON.stringify([legacyModel])],
		);
		legacyDb.close();

		const migrated = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(migrated).toBeNull();

		const replacementModel = createModel("fresh-cloud-model", "Fresh Cloud Model");
		writeModelCache("ollama-cloud", Date.now(), [replacementModel], true, "static-v3", dbPath);

		const fresh = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(fresh?.models.map(model => model.id)).toEqual(["fresh-cloud-model"]);
		expect(fresh?.staticFingerprint).toBe("static-v3");
	});

	it("strips credential-bearing headers before persisting, keeping other headers (#5780)", () => {
		const model = buildModel({
			id: "gated-model",
			name: "Gated Model",
			api: "openai-completions",
			provider: "runtime-ext",
			baseUrl: "https://ext.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
			headers: {
				Authorization: "Bearer super-secret-key-abc123",
				"X-Api-Key": "another-secret",
				"X-Project-Id": "proj-42",
			},
		});
		writeModelCache("runtime-ext", Date.now(), [model], true, "static-v1", dbPath);

		// The plaintext SQLite payload must not carry the credentials.
		const raw = new Database(dbPath, { readonly: true });
		const row = raw
			.query<{ models: string }, []>("SELECT models FROM model_cache WHERE provider_id = 'runtime-ext'")
			.get();
		raw.close();
		expect(row?.models.includes("super-secret-key-abc123")).toBe(false);
		expect(row?.models.includes("another-secret")).toBe(false);

		// Non-sensitive transport headers survive the round-trip; auth headers do not.
		const cached = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(cached?.models[0]?.headers).toEqual({ "X-Project-Id": "proj-42" });
	});
});
