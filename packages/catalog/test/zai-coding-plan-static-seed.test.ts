import { describe, expect, it } from "bun:test";
import {
	buildZaiCodingPlanStaticSeed,
	ZAI_CODING_PLAN_STATIC_SEED_MODELS,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("zai coding plan static seed", () => {
	it("ships glm-5.2 and glm-5.2[1m] with 1M context and 131072 max output", () => {
		const ids = ZAI_CODING_PLAN_STATIC_SEED_MODELS.map(m => m.id);
		expect(ids).toEqual(["glm-5.2", "glm-5.2[1m]"]);

		for (const model of buildZaiCodingPlanStaticSeed()) {
			expect(model.provider).toBe("zai");
			expect(model.api).toBe("anthropic-messages");
			expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
			expect(model.reasoning).toBe(true);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(131_072);
			expect(model.thinking?.mode).toBe("budget");
			expect(model.thinking?.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
		}
	});
});

import modelsJson from "../src/models.json";

describe("zai bundled catalog", () => {
	it("pins glm-5.2 default entry to 1M context", () => {
		const model = (modelsJson as Record<string, Record<string, { contextWindow: number; maxTokens: number }>>).zai[
			"glm-5.2"
		];
		expect(model).toBeDefined();
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
	});
});
