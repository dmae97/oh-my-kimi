import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import {
	applyChatCompletionsCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "../openai-shared";

const BASE_CHAT_COMPLETIONS_PARAMS: OpenAICompletionsParams = { messages: [], model: "unused", stream: true };

describe("Kimi K2.7 Code thinking policy", () => {
	it("omits disabled thinking for title-generator-style Kimi Code requests", () => {
		const model = getBundledModel("kimi-code", "kimi-for-coding");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		expect("thinking" in params).toBe(false);
	});

	it("omits disabled thinking for native Moonshot Kimi K2.7 Code variants", () => {
		for (const modelId of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
			const model = getBundledModel("moonshot", modelId);
			const policy = resolveOpenAICompatPolicy(model, {
				endpoint: "chat-completions",
				disableReasoning: true,
			});
			const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };
			applyChatCompletionsCompatPolicy(params, policy);

			expect("thinking" in params).toBe(false);
		}
	});

	it("keeps explicit disabled thinking for Kimi K2.6", () => {
		const model = getBundledModel("moonshot", "kimi-k2.6");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		expect(params.thinking).toEqual({ type: "disabled" });
	});
});
