import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

/**
 * Claude Fable thinking contract.
 *
 * Fable rejects the pre-4.6 request shape outright: `thinking: {type: "enabled",
 * budget_tokens: N}` and any sampling parameter both return HTTP 400. Thinking
 * is always on and depth is selected through `output_config.effort`, which tops
 * out at `max`. These tests pin the request OMK actually builds, because the
 * failure mode is a 400 on every reasoning turn rather than a degraded answer.
 */
interface AnthropicThinkingPayload {
	temperature?: number;
	thinking?: { type?: string; budget_tokens?: number };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let captured: AnthropicThinkingPayload | undefined;

	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();

	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

const FABLE_MODELS = [
	["anthropic", "claude-fable-5"],
	["anthropic", "claude-fable-5-1"],
] as const;

describe("Claude Fable thinking", () => {
	it.each(FABLE_MODELS)("exposes the full effort ladder up to max (%s/%s)", (provider, id) => {
		const levels = getSupportedThinkingLevels(getModel(provider, id));

		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it.each(FABLE_MODELS)("sends adaptive thinking with effort max (%s/%s)", async (provider, id) => {
		const payload = await capturePayload(getModel(provider, id), { reasoning: "max" });

		expect(payload.thinking?.type).toBe("adaptive");
		// budget_tokens is rejected with a 400 on this family.
		expect(payload.thinking?.budget_tokens).toBeUndefined();
		expect(payload.output_config?.effort).toBe("max");
	});

	it("maps each thinking level onto its own effort", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const efforts = await Promise.all(
			(["low", "medium", "high", "xhigh", "max"] as const).map(async (reasoning) => {
				const payload = await capturePayload(model, { reasoning });
				return payload.output_config?.effort;
			}),
		);

		expect(efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each(FABLE_MODELS)("drops sampling parameters (%s/%s)", async (provider, id) => {
		const payload = await capturePayload(getModel(provider, id), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
	});
});
