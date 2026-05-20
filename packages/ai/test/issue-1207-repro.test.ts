import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { detectOpenAICompat, resolveOpenAICompat } from "@oh-my-pi/pi-ai/providers/openai-completions-compat";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import * as z from "zod/v4";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: z.object({ text: z.string() }),
};

const contextWithTools: Context = {
	messages: [{ role: "user", content: "call echo", timestamp: Date.now() }],
	tools: [echoTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, contextWithTools, {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning: "minimal",
		toolChoice: "auto",
		maxTokens: 123,
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

function customDeepseekFlash(): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		provider: "ds",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: true,
		compat: {
			supportsReasoningEffort: true,
			reasoningEffortMap: { xhigh: "max" },
		},
	};
}

describe("issue #1207 — DeepSeek V4 keeps reasoning with tools", () => {
	it("detects the documented direct DeepSeek V4 compat shape", () => {
		const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const compat = detectOpenAICompat(model);

		expect(compat.supportsToolChoice).toBe(false);
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.extraBody).toEqual({ thinking: { type: "enabled" } });
		expect(compat.reasoningEffortMap).toMatchObject({
			minimal: "high",
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
		});
	});

	it("merges partial user reasoning maps with DeepSeek defaults", () => {
		const compat = resolveOpenAICompat(customDeepseekFlash());

		expect(compat.supportsToolChoice).toBe(false);
		expect(compat.reasoningEffortMap).toMatchObject({
			minimal: "high",
			low: "high",
			medium: "high",
			xhigh: "max",
		});
	});

	it("omits tool_choice but preserves documented reasoning when tools are present", async () => {
		const body = await capturePayload(customDeepseekFlash());

		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.thinking).toEqual({ type: "enabled" });
		expect(body.max_tokens).toBe(123);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("preserves OpenRouter reasoning when tool_choice auto is present", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const compat = detectOpenAICompat(model);
		const body = await capturePayload(model);

		expect(compat.disableReasoningOnToolChoice).toBe(false);
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.reasoning_effort).toBeUndefined();
	});
});
