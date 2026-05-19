/**
 * Fire Pass (Fireworks Kimi K2.6 Turbo subscription) wiring.
 *
 * Fire Pass keys (`fpk_…`) authorize only the `accounts/fireworks/routers/kimi-k2p6-turbo`
 * router and reject `/v1/models`. The bundled catalog stores a friendly public id
 * (`kimi-k2.6-turbo`) and the openai-completions provider translates it to the wire
 * form at request time.
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

describe("Fire Pass provider", () => {
	it("ships a bundled Kimi K2.6 Turbo entry on the firepass provider", () => {
		const model = getBundledModel("firepass", "kimi-k2.6-turbo");
		expect(model).toBeDefined();
		expect(model.provider).toBe("firepass");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
		expect(model.reasoning).toBe(true);
	});

	it("translates the friendly id to the router wire id when calling chat completions", async () => {
		const model = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
		const captured: { body: string | null } = { body: null };
		global.fetch = (async (_input: unknown, init?: RequestInit) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseResponse([
				{ choices: [{ delta: { content: "ok" }, index: 0 }] },
				{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
				"[DONE]",
			]);
		}) as typeof global.fetch;

		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "fpk_test",
		});
		for await (const _event of stream) {
			/* drain */
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as { model?: unknown };
		expect(parsed.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
	});
});
