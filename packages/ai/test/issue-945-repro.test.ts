import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { detectCompat, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Tool } from "@oh-my-pi/pi-ai/types";
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

describe("issue #945 — OpenCode Go DeepSeek does not support tool_choice", () => {
	it("detects deepseek-v4-pro as not supporting tool_choice even without generated compat", () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-pro");
		expect(model.compat?.supportsToolChoice).toBeUndefined();
		expect(detectCompat(model).supportsToolChoice).toBe(false);
	});

	it("omits tool_choice while preserving tools and reasoning_effort", async () => {
		const body = await capturePayload({ reasoning: "high", toolChoice: "auto" });
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
	});
});
