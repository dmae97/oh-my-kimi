import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

describe("OpenCode provider discovery", () => {
	test("treats the OpenCode model endpoints as authoritative catalogs", () => {
		for (const providerId of ["opencode-go", "opencode-zen"]) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		}
		expect(opencodeGoModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
		expect(opencodeZenModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
	});

	test("replaces stale bundled Zen models with the live endpoint list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-"));
		try {
			const options = opencodeZenModelManagerOptions({
				apiKey: "zen-test-key",
				fetch: async () =>
					Response.json({
						object: "list",
						data: LIVE_FREE_MODEL_IDS.map(id => ({ id, object: "model", owned_by: "opencode" })),
					}),
			});
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.stale).toBe(false);
			expect(result.models.map(model => model.id).sort()).toEqual([...LIVE_FREE_MODEL_IDS].sort());
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
