import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type } from "arktype";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

function contextWithTools(tools: Tool[] = [echoTool]): Context {
	return {
		messages: [{ role: "user", content: "call tool", timestamp: Date.now() }],
		tools,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(model: Model<"openai-completions">, tools?: Tool[]): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, contextWithTools(tools), {
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
	return buildModel({
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
	} as ModelSpec<"openai-completions">);
}

describe("issue #1207 — DeepSeek V4 keeps reasoning with tools", () => {
	it("detects the documented direct DeepSeek V4 compat shape", () => {
		const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const compat = model.compat;

		expect(compat.supportsToolChoice).toBe(false);
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.extraBody).toEqual({ thinking: { type: "enabled" } });
		expect(model.thinking?.effortMap).toMatchObject({
			minimal: "high",
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
		});
	});

	it("merges partial user reasoning maps with DeepSeek defaults in thinking metadata", () => {
		const model = customDeepseekFlash();

		expect(model.compat.supportsToolChoice).toBe(false);
		expect(model.thinking?.effortMap).toMatchObject({
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

	it("does not mix Fireworks DeepSeek effort with the native thinking toggle", async () => {
		const model = getBundledModel("fireworks", "deepseek-v4-pro") as Model<"openai-completions">;
		const compat = model.compat;
		const body = await capturePayload(model);

		expect(compat.extraBody).toBeUndefined();
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.thinking).toBeUndefined();
		expect(body.max_tokens).toBe(123);
	});

	it("preserves OpenRouter reasoning when tool_choice auto is present", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const compat = model.compat;
		const body = await capturePayload(model);

		expect(compat.disableReasoningOnToolChoice).toBe(false);
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("does not nest anyOf branches in OpenRouter DeepSeek tool schemas", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const unionTool: Tool = {
			name: "union_repro",
			description: "Union schema repro",
			parameters: type({
				paths: "(string | string[])?",
			}),
		};
		const body = await capturePayload(model, [unionTool]);
		const tools = body.tools as Array<{ function: { parameters: Record<string, unknown> } }>;
		const properties = tools[0].function.parameters.properties as Record<string, Record<string, unknown>>;
		const branches = properties.paths.anyOf as Array<Record<string, unknown>>;

		expect(branches.map(branch => branch.type)).toEqual(["string", "array", "null"]);
		expect(branches.some(branch => Array.isArray(branch.anyOf))).toBe(false);
	});
});
