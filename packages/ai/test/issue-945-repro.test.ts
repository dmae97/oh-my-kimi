import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { Type } from "@sinclair/typebox";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: Type.Object({ text: Type.String() }),
};

const context: Context = {
	messages: [{ role: "user", content: "call echo", timestamp: Date.now() }],
	tools: [echoTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(opts: Parameters<typeof streamOpenAICompletions>[2]): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(getBundledModel("opencode-go", "deepseek-v4-pro"), context, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

describe("issue #945 — OpenCode Go DeepSeek tool_choice is disabled", () => {
	it("marks deepseek-v4-pro as not supporting tool_choice via compat override", () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-pro") as Model<"openai-completions">;
		expect(model.compat?.supportsToolChoice).toBe(false);
	});

	it("omits tool_choice from payload but preserves tools and reasoning_effort", async () => {
		const body = await capturePayload({ reasoning: "high", toolChoice: "auto" });
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
	});
});
