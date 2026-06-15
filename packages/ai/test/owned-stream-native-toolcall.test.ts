import { describe, expect, it } from "bun:test";
import { wrapInbandToolStream } from "../src/grammar/owned-stream";
import type { AssistantMessage, ThinkingContent, ToolCall, Usage } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const TOOLS = [
	{
		name: "todo",
		description: "Manage the todo list.",
		parameters: {
			type: "object",
			properties: { ops: { type: "array" } },
			required: ["ops"],
		},
	},
];

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

// Gemini (via OpenRouter) keeps emitting native `tool_calls` even in owned mode
// where no `tools` are sent — the in-band scanner only reconstructs calls from
// `tool_code` text, so the projector must forward native calls instead of
// dropping them.
function makeGeminiInner(): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	const seed = makeAssistant([]);
	inner.push({ type: "start", partial: seed });
	const thinking: ThinkingContent = { type: "thinking", thinking: "Checking the todo list." };
	inner.push({ type: "thinking_start", contentIndex: 0, partial: seed });
	inner.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial: seed });
	inner.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: seed });
	const call: ToolCall = { type: "toolCall", id: "tool_todo_abc", name: "todo", arguments: {} };
	inner.push({ type: "toolcall_start", contentIndex: 1, partial: seed });
	inner.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"ops":[{"op":"view"}]}', partial: seed });
	const finalCall: ToolCall = { ...call, arguments: { ops: [{ op: "view" }] } };
	inner.push({ type: "toolcall_end", contentIndex: 1, toolCall: finalCall, partial: seed });
	const full = makeAssistant([thinking, finalCall]);
	inner.push({ type: "done", reason: "toolUse", message: full });
	inner.end(full);
	return inner;
}

describe("wrapInbandToolStream native tool-call passthrough", () => {
	it("forwards a provider-native tool call that arrives without in-band text", async () => {
		const events: string[] = [];
		const wrapped = wrapInbandToolStream(makeGeminiInner(), TOOLS, "gemini");
		for await (const event of wrapped) events.push(event.type);
		const message = await wrapped.result();

		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.id).toBe("tool_todo_abc");
		expect(calls[0]!.arguments).toEqual({ ops: [{ op: "view" }] });
		// Reasoning is preserved alongside the forwarded call.
		expect(message.content.some(b => b.type === "thinking")).toBe(true);
		// A turn with a tool call is "toolUse", never a content-less "stop".
		expect(message.stopReason).toBe("toolUse");
		// The streamed projection emits the native call's lifecycle so live UI updates.
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_end");
	});
});
