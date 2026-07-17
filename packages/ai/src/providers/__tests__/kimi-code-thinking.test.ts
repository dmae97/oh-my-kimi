import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import * as kimiOauth from "../../registry/oauth/kimi";
import type { Context } from "../../types";
import type { MessageCreateParamsStreaming } from "../anthropic-wire";
import { streamKimi } from "../kimi";
import { streamOpenAIAnthropicShim } from "../openai-anthropic-shim";
import {
	applyChatCompletionsCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "../openai-shared";

const BASE_CHAT_COMPLETIONS_PARAMS: OpenAICompletionsParams = { messages: [], model: "unused", stream: true };
const KIMI_HEADERS = Object.freeze({
	"User-Agent": "KimiCLI/test",
	"X-Msh-Platform": "kimi_cli",
	"X-Msh-Version": "test",
	"X-Msh-Device-Name": "test",
	"X-Msh-Device-Model": "test",
	"X-Msh-Os-Version": "test",
	"X-Msh-Device-Id": "test",
});
const TITLE_CONTEXT: Context = {
	systemPrompt: ["Generate a title."],
	messages: [{ role: "user", content: "Explain the login failure", timestamp: 0 }],
	tools: [
		{
			name: "set_title",
			description: "Set title",
			parameters: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
				additionalProperties: false,
			},
		},
	],
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Kimi K2.7 Code thinking policy", () => {
	it("expresses disabled thinking explicitly for title-generator-style Kimi Code requests", () => {
		const model = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		// Kimi's native hosts speak the z.ai binary thinking field: a disabled
		// request carries `{ type: "disabled" }` rather than omitting the block.
		expect((params as Record<string, unknown>).thinking).toEqual({ type: "disabled" });
		// Thinking yields to a forced tool choice (#5758 review): the choice is
		// honored and reasoning is turned off, instead of downgrading the choice.
		expect(model.compat.supportsForcedToolChoice).toBe(true);
		expect(model.compat.disableReasoningOnForcedToolChoice).toBe(true);
	});

	it("keeps the forced tool choice and omits thinking on Kimi Code's Anthropic endpoint", async () => {
		const model = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		let payload: MessageCreateParamsStreaming | undefined;
		const stream = streamOpenAIAnthropicShim(
			model,
			TITLE_CONTEXT,
			{
				apiKey: "test-key",
				maxTokens: 1024,
				disableReasoning: true,
				toolChoice: { type: "tool", name: "set_title" },
				onPayload: body => {
					payload = body as MessageCreateParamsStreaming;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.kimi.com/coding",
				defaultFormat: "anthropic",
			},
		);

		await stream.result();

		// With reasoning disabled the Anthropic wire carries no thinking block,
		// and the forced tool choice survives (thinking yields to the choice).
		expect(payload?.thinking).toBeUndefined();
		expect(payload?.tool_choice).toEqual({ type: "tool", name: "set_title" });
	});

	it("uses the configured Kimi base URL for Anthropic requests", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);
		const bundledModel = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		const model = { ...bundledModel, baseUrl: "https://gateway.example.com/v1" };
		let requestedUrl: string | undefined;
		const stream = streamKimi(
			model,
			{
				systemPrompt: [],
				messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
				tools: [],
			},
			{
				format: "anthropic",
				apiKey: "gateway-key",
				fetch: async input => {
					requestedUrl = String(input);
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "authentication_error", message: "stop after URL capture" },
						}),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				},
			},
		);

		await stream.result();

		expect(requestedUrl).toBe("https://gateway.example.com/v1/messages");
	});

	it("omits disabled thinking for native Moonshot Kimi K2.7 Code variants", () => {
		for (const modelId of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
			const model = getBundledModel<"openai-completions">("moonshot", modelId);
			const policy = resolveOpenAICompatPolicy(model, {
				endpoint: "chat-completions",
				disableReasoning: true,
			});
			const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };
			applyChatCompletionsCompatPolicy(params, policy);

			expect("thinking" in params).toBe(false);
			expect(model.compat.supportsForcedToolChoice).toBe(false);
		}
	});

	it("keeps the openai disable shape for non-native Kimi K2.7 Code aliases", () => {
		for (const { provider, id } of [
			{ provider: "fireworks", id: "kimi-k2.7-code" },
			{ provider: "openrouter", id: "moonshotai/kimi-k2.7-code" },
		] as const) {
			const model = getBundledModel<"openai-completions">(provider, id);
			expect(model.compat.supportsForcedToolChoice).toBe(true);
			expect(model.compat.reasoningDisableMode).not.toBe("omit");
		}
	});

	it("keeps explicit disabled thinking for Kimi K2.6", () => {
		const model = getBundledModel<"openai-completions">("moonshot", "kimi-k2.6");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		expect(params.thinking).toEqual({ type: "disabled" });
	});
});
