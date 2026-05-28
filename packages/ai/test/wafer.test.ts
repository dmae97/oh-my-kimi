/**
 * Wafer Pass + Wafer Serverless provider wiring.
 *
 * Wafer exposes a single OpenAI-compatible base URL (`https://pass.wafer.ai/v1`)
 * for two SKUs whose entitlement differs server-side:
 *  - `wafer-pass` (flat-rate)
 *  - `wafer-serverless` (pay-as-you-go)
 *
 * Both providers route through `openai-completions` and the catalog id matches
 * the wire id (no rewrite). These tests defend the bundled catalog contract and
 * the case-sensitive id pass-through against the wire.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createModelManager } from "../src/model-manager";
import { getBundledModel } from "../src/models";
import { waferPassModelManagerOptions, waferServerlessModelManagerOptions } from "../src/provider-models/openai-compat";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Wafer Pass provider", () => {
	it("ships a bundled GLM-5.1 entry with zai-family thinking compat", () => {
		const model = getBundledModel<"openai-completions">("wafer-pass", "GLM-5.1");
		expect(model).toBeDefined();
		expect(model.id).toBe("GLM-5.1");
		expect(model.provider).toBe("wafer-pass");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://pass.wafer.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.compat?.thinkingFormat).toBe("zai");
		expect(model.compat?.reasoningContentField).toBe("reasoning_content");
		expect(model.compat?.supportsDeveloperRole).toBe(false);
	});

	it("ships a bundled Qwen3.5-397B-A17B entry with vision input and no reasoning", () => {
		const model = getBundledModel<"openai-completions">("wafer-pass", "Qwen3.5-397B-A17B");
		expect(model).toBeDefined();
		expect(model.id).toBe("Qwen3.5-397B-A17B");
		expect(model.provider).toBe("wafer-pass");
		expect(model.reasoning).toBe(false);
		expect(model.input).toEqual(["text", "image"]);
	});

	it("preserves the catalog id verbatim on the wire (no rewrite, case-sensitive)", async () => {
		const model = getBundledModel<"openai-completions">("wafer-pass", "GLM-5.1");
		const captured: { url: string | null; body: string | null } = { url: null, body: null };
		global.fetch = (async (input: unknown, init?: RequestInit) => {
			captured.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse(["[DONE]"]);
		}) as typeof global.fetch;

		const context: Context = {
			systemPrompt: ["t"],
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "wfr_test",
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.url).toBe("https://pass.wafer.ai/v1/chat/completions");
		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { model?: unknown };
		// Wafer's docs note model names are case-insensitive on input, but the
		// canonical id has mixed case; we must round-trip it unchanged so users
		// who pin `GLM-5.1` don't end up with usage rows under `glm-5.1` or
		// hitting the upstream 404 path.
		expect(parsed.model).toBe("GLM-5.1");
	});
});

describe("Wafer Serverless provider", () => {
	it("ships the documented Serverless catalog (GLM-5.1, Qwen3.5, Qwen3.6, Qwen3.7-Max, Kimi-K2.6, DeepSeek V4 Flash/Pro)", () => {
		const glm = getBundledModel<"openai-completions">("wafer-serverless", "GLM-5.1");
		expect(glm).toBeDefined();
		expect(glm.provider).toBe("wafer-serverless");
		expect(glm.baseUrl).toBe("https://pass.wafer.ai/v1");
		expect(glm.compat?.thinkingFormat).toBe("zai");

		const qwen35 = getBundledModel<"openai-completions">("wafer-serverless", "Qwen3.5-397B-A17B");
		expect(qwen35).toBeDefined();
		expect(qwen35.provider).toBe("wafer-serverless");

		const kimi = getBundledModel<"openai-completions">("wafer-serverless", "Kimi-K2.6");
		expect(kimi).toBeDefined();
		expect(kimi.contextWindow).toBe(262144);
		// Kimi-K2.6 routes to Moonshot upstream, which uses zai-style binary
		// `thinking: { type: "enabled" | "disabled" }`. Locked in explicitly so a
		// future regen with credentials cannot silently strip it (auto-detect
		// would mis-pick "openai" because the Wafer baseUrl/provider doesn't match
		// the api.moonshot.ai / api.kimi.com URL patterns in `detectOpenAICompat`).
		expect(kimi.compat?.thinkingFormat).toBe("zai");
		// Kimi-K2.6's retail Serverless rate per wafer.ai (= API cents × 0.0125):
		// $1.10 in / $4.80 out / $0.1125 cached.
		expect(kimi.cost).toEqual({ input: 1.1, output: 4.8, cacheRead: 0.1125, cacheWrite: 0 });

		const qwen36 = getBundledModel<"openai-completions">("wafer-serverless", "Qwen3.6-35B-A3B");
		expect(qwen36).toBeDefined();
		// Qwen3.6 advertises 256k context and vision per the live /v1/models response.
		expect(qwen36.contextWindow).toBe(256000);
		expect(qwen36.input).toEqual(["text", "image"]);

		const qwen37max = getBundledModel<"openai-completions">("wafer-serverless", "qwen3.7-max");
		expect(qwen37max).toBeDefined();
		// Wafer's canonical id is lowercase `qwen3.7-max` — must round-trip verbatim.
		expect(qwen37max.id).toBe("qwen3.7-max");
		expect(qwen37max.name).toBe("Qwen3.7-Max");
		expect(qwen37max.reasoning).toBe(true);
		// qwen3.7-max routes to Alibaba upstream; native wire format is `enable_thinking`.
		// The bundled entry leaves `thinkingFormat` unset so `detectOpenAICompat` picks "qwen"
		// from the lowercase id at request time.
		expect(qwen37max.compat?.thinkingFormat).toBeUndefined();

		const dsFlash = getBundledModel<"openai-completions">("wafer-serverless", "deepseek-v4-flash");
		expect(dsFlash).toBeDefined();
		// DeepSeek V4 family uses `reasoning_effort`, not zai's `thinking: {type}`.
		// Bundled entry must NOT pin `thinkingFormat: "zai"` — `detectOpenAICompat`
		// auto-picks "openai" (default) from the deepseek-* id pattern at request time.
		expect(dsFlash.compat?.thinkingFormat).toBeUndefined();
		expect(dsFlash.contextWindow).toBe(1000000);
		expect(dsFlash.reasoning).toBe(true);
		expect(dsFlash.compat?.reasoningContentField).toBe("reasoning_content");

		const dsPro = getBundledModel<"openai-completions">("wafer-serverless", "deepseek-v4-pro");
		expect(dsPro).toBeDefined();
		expect(dsPro.contextWindow).toBe(1000000);
		expect(dsPro.reasoning).toBe(true);
		expect(dsPro.compat?.thinkingFormat).toBeUndefined();
	});

	it("does not expose Serverless-only ids on the Wafer Pass catalog", () => {
		expect(getBundledModel("wafer-pass", "Kimi-K2.6")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "Qwen3.6-35B-A3B")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "qwen3.7-max")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "deepseek-v4-flash")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "deepseek-v4-pro")).toBeUndefined();
	});
});
describe("Wafer dynamic discovery mapper", () => {
	// Synthetic /v1/models response that exercises every upstream provider Wafer
	// announces, including a deliberately-unknown one. The mapper must:
	//  - pin `thinkingFormat: "zai"` for upstreams whose native API uses the
	//    z.ai-style binary thinking parameter (zai, moonshotai),
	//  - pin `thinkingFormat: "qwen"` for Alibaba qwen models,
	//  - leave `thinkingFormat` unset for deepseek (uses `reasoning_effort`)
	//    and unknown upstreams, so `detectOpenAICompat` picks the safe default
	//    from the id pattern at request time.
	function mockWaferModelsResponse(entries: Array<Record<string, unknown>>): void {
		global.fetch = (async () =>
			new Response(JSON.stringify({ object: "list", data: entries }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof global.fetch;
	}

	function makeWaferEntry(id: string, upstream: string, opts: { reasoning?: boolean; vision?: boolean } = {}) {
		return {
			id,
			object: "model",
			max_model_len: 100000,
			wafer: {
				display_name: id,
				tier: "serverless_only",
				provider: upstream,
				context_length: 100000,
				capabilities: {
					vision: opts.vision === true,
					tools: true,
					reasoning: opts.reasoning === true,
				},
				pricing: {
					currency: "usd",
					input_cents_per_million: 100,
					output_cents_per_million: 300,
					cache_read_cents_per_million: 10,
				},
			},
		};
	}

	it("picks thinkingFormat from the wafer.provider envelope per upstream", async () => {
		mockWaferModelsResponse([
			makeWaferEntry("GLM-fake", "zai", { reasoning: true }),
			makeWaferEntry("Kimi-fake", "moonshotai", { reasoning: true }),
			makeWaferEntry("qwen-fake", "qwen", { reasoning: true }),
			makeWaferEntry("deepseek-fake", "deepseek", { reasoning: true }),
			makeWaferEntry("mystery-fake", "future-provider", { reasoning: true }),
			makeWaferEntry("nothink-fake", "zai", { reasoning: false }),
		]);

		const manager = createModelManager(waferServerlessModelManagerOptions({ apiKey: "wfr_test" }));
		const { models } = await manager.refresh("online");

		const byId = new Map(models.map(m => [m.id, m as Model<"openai-completions">]));
		expect(byId.get("GLM-fake")?.compat?.thinkingFormat).toBe("zai");
		expect(byId.get("Kimi-fake")?.compat?.thinkingFormat).toBe("zai");
		expect(byId.get("qwen-fake")?.compat?.thinkingFormat).toBe("qwen");
		// deepseek and unknown upstreams: thinkingFormat unset so detectOpenAICompat
		// picks from the id pattern at request time (deepseek → "openai" effort).
		expect(byId.get("deepseek-fake")?.compat?.thinkingFormat).toBeUndefined();
		expect(byId.get("mystery-fake")?.compat?.thinkingFormat).toBeUndefined();
		// Non-reasoning entries never receive a thinkingFormat hint regardless of upstream.
		expect(byId.get("nothink-fake")?.compat?.thinkingFormat).toBeUndefined();
		expect(byId.get("nothink-fake")?.reasoning).toBe(false);
		// All entries keep reasoning_content as the canonical field for reasoning models.
		for (const id of ["GLM-fake", "Kimi-fake", "qwen-fake", "deepseek-fake", "mystery-fake"]) {
			expect(byId.get(id)?.compat?.reasoningContentField).toBe("reasoning_content");
		}
	});

	it("zeros cost for the Pass SKU and applies retail × 0.0125 for Serverless", async () => {
		// Same upstream record served via both SKUs — `wafer.pricing` in cents/M:
		// 120/360/12. Pass is a flat-rate subscription (no per-token charge), so
		// `mapWaferModel` zeros the cost regardless of envelope values. Serverless
		// is pay-as-you-go and applies the empirical × 0.0125 conversion to match
		// wafer.ai's published retail rates (120 cents → $1.50/M).
		const sharedEntry = {
			id: "Shared-fake",
			object: "model",
			max_model_len: 100000,
			wafer: {
				display_name: "Shared-fake",
				tier: "pass_included",
				provider: "zai",
				context_length: 100000,
				capabilities: { vision: false, tools: true, reasoning: true },
				pricing: {
					currency: "usd",
					input_cents_per_million: 120,
					output_cents_per_million: 360,
					cache_read_cents_per_million: 12,
				},
			},
		};

		mockWaferModelsResponse([sharedEntry]);
		const passManager = createModelManager(waferPassModelManagerOptions({ apiKey: "wfr_test" }));
		const passResult = await passManager.refresh("online");
		const passModel = passResult.models.find(m => m.id === "Shared-fake");
		expect(passModel).toBeDefined();
		expect(passModel?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		mockWaferModelsResponse([sharedEntry]);
		const srvManager = createModelManager(waferServerlessModelManagerOptions({ apiKey: "wfr_test" }));
		const srvResult = await srvManager.refresh("online");
		const srvModel = srvResult.models.find(m => m.id === "Shared-fake");
		expect(srvModel).toBeDefined();
		// 120 × 0.0125 = 1.50, 360 × 0.0125 = 4.50, 12 × 0.0125 = 0.15 — matches
		// the wafer.ai Serverless rate card for GLM-5.1.
		expect(srvModel?.cost).toEqual({ input: 1.5, output: 4.5, cacheRead: 0.15, cacheWrite: 0 });
	});
});
