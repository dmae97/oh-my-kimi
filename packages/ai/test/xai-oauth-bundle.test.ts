import { describe, expect, it } from "bun:test";
import MODELS_JSON from "../src/models.json" with { type: "json" };
import { buildXaiOAuthStaticSeed } from "../src/provider-models/openai-compat";
import type { Model } from "../src/types";

// Pins the invariant: bundled `models.json` carries every entry the runtime
// curated catalog (XAI_OAUTH_CURATED_MODELS, surfaced via
// buildXaiOAuthStaticSeed) emits. Without this, editing the curated list
// without regenerating `models.json` silently regresses the boot-time
// default-model resolver — the registry sees the runtime seed only after
// `refresh()`, but interactive boot resolves the persisted default
// synchronously from `#loadModels()`, which reads only `models.json`.
//
// Failure here means: run `bun run generate-models` and commit the diff.
describe("xai-oauth bundled catalog (regression)", () => {
	const bundled = (MODELS_JSON as Record<string, Record<string, Model>>)["xai-oauth"] ?? {};
	const seed = buildXaiOAuthStaticSeed();

	it("bundles every curated id", () => {
		const seededIds = seed.map(model => model.id).sort();
		const bundledIds = Object.keys(bundled).sort();
		expect(bundledIds).toEqual(seededIds);
	});

	for (const seededModel of seed) {
		it(`matches contract for ${seededModel.id}`, () => {
			const bundledEntry = bundled[seededModel.id];
			expect(bundledEntry, `xai-oauth/${seededModel.id} missing from models.json`).toBeDefined();
			expect(bundledEntry.id).toBe(seededModel.id);
			expect(bundledEntry.name).toBe(seededModel.name);
			expect(bundledEntry.provider).toBe("xai-oauth");
			expect(bundledEntry.api).toBe("openai-responses");
			expect(bundledEntry.contextWindow).toBe(seededModel.contextWindow);
			expect(bundledEntry.reasoning).toBe(seededModel.reasoning);
			// Input modality must survive both the curated seed and the bundle.
			// Without this the static fallback used on offline boot strips
			// vision capability silently (Codex PR #1127 review).
			expect(bundledEntry.input).toEqual(seededModel.input);
			expect(bundledEntry.compat?.supportsReasoningEffort).toBe(seededModel.compat?.supportsReasoningEffort);
		});
	}
});
