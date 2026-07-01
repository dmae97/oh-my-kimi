import { describe, expect, it } from "bun:test";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";

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
});
