import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(model: Model<"anthropic-messages">, speed: "fast" | "standard" | undefined): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		speed,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Anthropic fast mode (speed: 'fast')", () => {
	it("sets speed='fast' on the request body for Claude Opus 4.7", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), "fast")) as {
			speed?: string;
		};
		expect(payload.speed).toBe("fast");
	});

	it("sets speed='fast' on the request body for Claude Opus 4.6", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-6"), "fast")) as {
			speed?: string;
		};
		expect(payload.speed).toBe("fast");
	});

	it("forwards speed='fast' for any model and lets the server decide what's supported", async () => {
		// We deliberately don't gate client-side so future model additions
		// (Opus 4.8, Sonnet 4.x, etc.) don't require an SDK release. The server
		// returns invalid_request_error naming the model when unsupported.
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-5"), "fast")) as {
			speed?: string;
		};
		expect(payload.speed).toBe("fast");
	});

	it("omits the speed field when not requested", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), undefined)) as Record<
			string,
			unknown
		>;
		expect(payload.speed).toBeUndefined();
	});

	it("omits the speed field when explicitly 'standard'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), "standard")) as Record<
			string,
			unknown
		>;
		// "standard" is the API default; we only forward "fast" to avoid invalidating
		// prompt caches that were primed without it.
		expect(payload.speed).toBeUndefined();
	});
});
