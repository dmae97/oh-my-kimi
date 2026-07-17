import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

// Z.AI GLM coding-plan token costs all showed as "Free" (issue #5598): the `zai`
// provider descriptor sourced the models.dev `zai-coding-plan` key, which reports
// all-$0 subscription rates. The `zai` (pay-as-you-go) key carries the real
// per-token rates for the identical GLM ids, matching how other subscription
// providers surface comparison pricing in `/models`.
describe("zai GLM pricing sources the PAYG models.dev key (issue #5598)", () => {
	test("descriptor maps the `zai` models.dev key, not `zai-coding-plan`", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "zai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.modelsDevKey).toBe("zai");
		expect(descriptor?.api).toBe("anthropic-messages");
		expect(descriptor?.baseUrl).toBe("https://api.z.ai/api/anthropic");
	});

	test("mapped zai models carry the PAYG per-token costs, not the coding-plan $0 rates", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
			"zai-coding-plan": {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
		};

		const zai = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "zai",
		);
		const glm52 = zai.find(model => model.id === "glm-5.2");
		expect(glm52).toBeDefined();
		expect(glm52?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
	});
});
