import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const CUSTOM_MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-haiku-4.5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "internal-anthropic",
	baseUrl: "https://llm.example.com/v1/messages",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const TOOLS: Tool[] = [
	{
		name: "ping",
		description: "ping",
		parameters: {
			type: "object",
			properties: { msg: { type: "string" } },
			required: ["msg"],
		} as TJsonSchema,
	},
];

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
	tools: TOOLS,
};

function aborted(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

describe("issue #5572 — custom Anthropic endpoints reject eager_input_streaming", () => {
	it("omits eager_input_streaming from custom endpoint tool definitions", async () => {
		const model = buildModel(CUSTOM_MODEL_SPEC);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-test",
			signal: aborted(),
			onPayload: payload => resolve(payload),
		});

		const payload = (await promise) as { tools?: Array<Record<string, unknown>> };
		expect(payload.tools).toHaveLength(1);
		expect(payload.tools?.[0]).not.toHaveProperty("eager_input_streaming");
	});

	it("keeps eager tool input streaming on the official Anthropic endpoint", () => {
		const model = buildModel({
			...CUSTOM_MODEL_SPEC,
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
		});

		expect(model.compat.supportsEagerToolInputStreaming).toBe(true);
	});
});
