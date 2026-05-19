import { describe, expect, it } from "bun:test";
import { clearAnthropicFastModeFallback, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ProviderSessionState, ServiceTier } from "@oh-my-pi/pi-ai/types";

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

type CaptureOptions = {
	serviceTier?: ServiceTier;
	providerSessionState?: Map<string, ProviderSessionState>;
};

function capturePayload(model: Model<"anthropic-messages">, opts: CaptureOptions): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		serviceTier: opts.serviceTier,
		providerSessionState: opts.providerSessionState,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Anthropic priority service tier → speed='fast'", () => {
	it("sets speed='fast' for Claude Opus 4.7 when serviceTier='priority'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("sets speed='fast' for Claude Opus 4.6 when serviceTier='priority'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-6"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("forwards speed='fast' for any model — server decides what's supported", async () => {
		// Not gated client-side so future model additions (Opus 4.8, Sonnet 4.x, etc.)
		// don't need an SDK release. Server returns invalid_request_error naming the
		// model when unsupported.
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-5"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("omits speed when serviceTier is unset", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: undefined,
		})) as Record<string, unknown>;
		expect(payload.speed).toBeUndefined();
	});

	it("omits speed for non-priority tiers (`flex`, `scale`, `auto`, `default`)", async () => {
		for (const tier of ["flex", "scale", "auto", "default"] as const) {
			const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
				serviceTier: tier,
			})) as Record<string, unknown>;
			expect(payload.speed).toBeUndefined();
		}
	});

	it("sets speed='fast' on direct anthropic when serviceTier='claude-only'", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: "claude-only",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	it("omits speed when serviceTier='openai-only' on an anthropic model", async () => {
		// Scoped to OpenAI — on this anthropic request, the scope doesn't match,
		// so `speed` must not be set on the wire.
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-7"), {
			serviceTier: "openai-only",
		})) as Record<string, unknown>;
		expect(payload.speed).toBeUndefined();
	});
});

describe("clearAnthropicFastModeFallback", () => {
	it("is a no-op when no provider session state map is passed", () => {
		expect(() => clearAnthropicFastModeFallback(undefined)).not.toThrow();
	});

	it("is a no-op when the anthropic state entry hasn't been materialized", () => {
		const map = new Map<string, ProviderSessionState>();
		clearAnthropicFastModeFallback(map);
		expect(map.size).toBe(0);
	});

	it("flips fastModeDisabled back to false without touching unrelated flags", () => {
		const map = new Map<string, ProviderSessionState>();
		const state = {
			strictToolsDisabled: true,
			fastModeDisabled: true,
			close: () => {},
		} as ProviderSessionState & { strictToolsDisabled: boolean; fastModeDisabled: boolean };
		map.set("anthropic-messages", state);

		clearAnthropicFastModeFallback(map);

		expect(state.fastModeDisabled).toBe(false);
		// Strict-tools learning survives — only the fast-mode flag is reset.
		expect(state.strictToolsDisabled).toBe(true);
	});
});
