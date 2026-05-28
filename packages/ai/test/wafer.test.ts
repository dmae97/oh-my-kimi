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
import { getBundledModel } from "../src/models";
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
		// Kimi-K2.6 carries its real cents/M pricing (88 / 384 / 9 → 0.88 / 3.84 / 0.09).
		expect(kimi.cost).toEqual({ input: 0.88, output: 3.84, cacheRead: 0.09, cacheWrite: 0 });

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
		expect(qwen37max.compat?.thinkingFormat).toBe("zai");

		const dsFlash = getBundledModel<"openai-completions">("wafer-serverless", "deepseek-v4-flash");
		expect(dsFlash).toBeDefined();
		expect(dsFlash.contextWindow).toBe(1000000);
		expect(dsFlash.reasoning).toBe(true);
		expect(dsFlash.compat?.reasoningContentField).toBe("reasoning_content");

		const dsPro = getBundledModel<"openai-completions">("wafer-serverless", "deepseek-v4-pro");
		expect(dsPro).toBeDefined();
		expect(dsPro.contextWindow).toBe(1000000);
		expect(dsPro.reasoning).toBe(true);
	});

	it("does not expose Serverless-only ids on the Wafer Pass catalog", () => {
		expect(getBundledModel("wafer-pass", "Kimi-K2.6")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "Qwen3.6-35B-A3B")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "qwen3.7-max")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "deepseek-v4-flash")).toBeUndefined();
		expect(getBundledModel("wafer-pass", "deepseek-v4-pro")).toBeUndefined();
	});
});
