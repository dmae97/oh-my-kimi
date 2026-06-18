import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const testContext: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

describe("ollama reasoning effort backfill reaches the Responses wire", () => {
	it("sends low instead of minimal for a stale ollama spec carrying no effort map", async () => {
		// Reproduces the HTTP 400 `invalid reasoning value: "minimal"` path: a
		// reasoning-capable Ollama model whose cached/custom spec predates the
		// remap. buildModel must backfill the effort map so the wire sends `low`.
		const model = buildModel({
			id: "gemma4:e4b",
			name: "gemma4:e4b",
			api: "openai-responses",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});

		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		streamOpenAIResponses(model, testContext, {
			apiKey: "test-key",
			signal: abortedSignal(),
			reasoning: "minimal",
			reasoningSummary: "auto",
			onPayload: payload => resolve(payload as Record<string, unknown>),
		});

		const payload = await promise;
		expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
	});
});
