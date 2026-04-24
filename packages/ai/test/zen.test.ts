import { describe, expect, it } from "bun:test";
import MODELS from "@oh-my-pi/pi-ai/models.json" with { type: "json" };
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { e2eApiKey } from "./oauth";

describe("OpenCode bundled models", () => {
	it("matches the current OpenCode Go model catalog", () => {
		const expectedModelIds = [
			"glm-5",
			"glm-5.1",
			"kimi-k2.5",
			"kimi-k2.6",
			"mimo-v2-omni",
			"mimo-v2-pro",
			"mimo-v2.5",
			"mimo-v2.5-pro",
			"minimax-m2.5",
			"minimax-m2.7",
			"qwen3.5-plus",
			"qwen3.6-plus",
		] as const;

		expect(Object.keys(MODELS["opencode-go"]).sort()).toEqual(expectedModelIds.slice().sort());
	});
});

describe.skipIf(!e2eApiKey("OPENCODE_API_KEY"))("OpenCode Models Smoke Test", () => {
	const providers = [
		{ key: "opencode-zen", label: "OpenCode Zen" },
		{ key: "opencode-go", label: "OpenCode Go" },
	] as const;

	providers.forEach(({ key, label }) => {
		const providerModels = Object.values(MODELS[key]);
		providerModels.forEach(model => {
			it(`${label}: ${model.id}`, async () => {
				const response = await complete(model as unknown as Model, {
					messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
				});

				expect(response.content).toBeTruthy();
				expect(response.stopReason).toBe("stop");
			}, 60000);
		});
	});
});
