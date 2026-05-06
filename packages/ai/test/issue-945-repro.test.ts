import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { detectCompat, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
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

describe("issue #945 — OpenCode Go DeepSeek disables reasoning when tool_choice is used", () => {
	it("detects deepseek-v4-pro as supporting tool_choice with per-request reasoning suppression", () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-pro") as Model<"openai-completions">;
		expect(model.compat?.supportsToolChoice).toBeUndefined();
		const compat = detectCompat(model);
		expect(compat.supportsToolChoice).toBe(true);
		expect(compat.disableReasoningOnToolChoice).toBe(true);
	});

	it("preserves tool_choice and tools while omitting reasoning_effort", async () => {
		const body = await capturePayload({ reasoning: "high", toolChoice: "auto" });
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning_effort).toBeUndefined();
	});
});
