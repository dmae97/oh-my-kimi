import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import type { Context } from "../../types";
import type { MessageCreateParamsStreaming } from "../anthropic-wire";
import { streamOpenAIAnthropicShim } from "../openai-anthropic-shim";
import {
	applyChatCompletionsCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "../openai-shared";

const BASE_CHAT_COMPLETIONS_PARAMS: OpenAICompletionsParams = { messages: [], model: "unused", stream: true };
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

describe("Kimi K2.7 Code thinking policy", () => {
	it("omits disabled thinking for title-generator-style Kimi Code requests", () => {
		const model = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		expect("thinking" in params).toBe(false);
		expect(model.compat.supportsForcedToolChoice).toBe(false);
	});

	it("enables thinking and downgrades forced tool choice on Kimi Code's Anthropic endpoint", async () => {
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

		expect(payload?.thinking?.type).toBe("enabled");
		expect(payload?.tool_choice).toEqual({ type: "auto" });
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
