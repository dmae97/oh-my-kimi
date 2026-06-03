/**
 * Repro for #1617 — OpenCode Zen/Go: MiniMax M3 (and M3 Free) are routed to
 * `anthropic-messages` despite the gateways only serving them at
 * `/v1/chat/completions`. Symptoms include raw MiniMax/tool-call markup
 * (`<invoke name="bash">`, `<tool_call>`, `<description>`, `<cwd>`,
 * `<|minimax|>`) leaking into the UI because OMP POSTs anthropic-shaped
 * requests to /v1/messages and the gateway returns non-Anthropic responses.
 *
 * models.dev declares these ids with `provider.npm = "@ai-sdk/anthropic"`,
 * which by default would resolve to anthropic-messages on opencode-zen/-go.
 * The descriptor must override these specific ids to openai-completions so
 * that regenerated models.json keeps the correct routing, AND so the
 * dynamic-fetch path (which reads the bundled models.json reference) does
 * not regress after a /v1/models cache refresh.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "../src/provider-models/openai-compat";

const OPENCODE_ZEN_BASE = "https://opencode.ai/zen/v1";
const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

describe("opencode-zen/-go resolver routes MiniMax M3 to openai-completions (issue #1617)", () => {
	const zenDescriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "opencode-zen");
	const goDescriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "opencode-go");

	// Per upstream models.dev (verified 2026-06-02 against
	// https://models.dev/api.json["opencode"].models and
	// https://models.dev/api.json["opencode-go"].models), the affected ids
	// carry `provider.npm = "@ai-sdk/anthropic"`. The naive @ai-sdk/anthropic
	// rule would route them to /v1/messages on opencode.ai/zen[/go] which
	// 404s. Per-id overrides must win.
	const npmAnthropic: ModelsDevModel = { provider: { npm: "@ai-sdk/anthropic" }, tool_call: true };

	describe("opencode-zen", () => {
		test.each([
			["minimax-m3"],
			["minimax-m3-free"],
		])("%s resolves to openai-completions on /v1/chat/completions", modelId => {
			const resolved = zenDescriptor?.resolveApi?.(modelId, npmAnthropic);
			expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_ZEN_BASE });
		});
	});

	describe("opencode-go", () => {
		test.each([
			["minimax-m3"],
			["minimax-m3-free"],
		])("%s resolves to openai-completions on /v1/chat/completions", modelId => {
			const resolved = goDescriptor?.resolveApi?.(modelId, npmAnthropic);
			expect(resolved).toEqual({ api: "openai-completions", baseUrl: OPENCODE_GO_BASE });
		});
	});

	test("opencode-zen /v1/models refresh routes a freshly-discovered M3 to openai-completions", async () => {
		let requestedUrl = "";
		const mockFetch = async (input: string | Request | URL): Promise<Response> => {
			requestedUrl = input instanceof Request ? input.url : String(input);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "minimax-m3-free",
							name: "MiniMax M3 Free",
							context_length: 200000,
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		global.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

		const options = opencodeZenModelManagerOptions({ apiKey: "opencode-test-key" });
		const models = await options.fetchDynamicModels?.();
		const m3 = models?.find(model => model.id === "minimax-m3-free");

		expect(requestedUrl).toBe("https://opencode.ai/zen/v1/models");
		expect(m3?.api).toBe("openai-completions");
		expect(m3?.baseUrl).toBe("https://opencode.ai/zen/v1");
	});

	test("opencode-go /v1/models refresh routes a freshly-discovered M3 to openai-completions", async () => {
		let requestedUrl = "";
		const mockFetch = async (input: string | Request | URL): Promise<Response> => {
			requestedUrl = input instanceof Request ? input.url : String(input);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "minimax-m3",
							name: "MiniMax M3",
							context_length: 200000,
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		global.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

		const options = opencodeGoModelManagerOptions({ apiKey: "opencode-test-key" });
		const models = await options.fetchDynamicModels?.();
		const m3 = models?.find(model => model.id === "minimax-m3");

		expect(requestedUrl).toBe("https://opencode.ai/zen/go/v1/models");
		expect(m3?.api).toBe("openai-completions");
		expect(m3?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
	});
});
