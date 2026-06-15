import { describe, expect, it } from "bun:test";
import { wrapInbandToolStream } from "../src/grammar/owned-stream";
import type { AssistantMessage, AssistantMessageEvent, ThinkingContent, ToolCall, Usage } from "../src/types";
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

// Drive an inner provider stream the way openai-completions does: a single
// growing `output` message whose `content` each event's `partial` points at.
function drive(
	build: (push: (event: AssistantMessageEvent) => void, out: AssistantMessage) => void,
): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	const out = makeAssistant([]);
	inner.push({ type: "start", partial: out });
	build(event => inner.push(event), out);
	inner.push({ type: "done", reason: out.stopReason === "length" ? "length" : "toolUse", message: out });
	inner.end(out);
	return inner;
}

// Gemini (via OpenRouter) keeps emitting native `tool_calls` even in owned mode
// where no `tools` are sent — the in-band scanner only reconstructs calls from
// `tool_code` text, so the projector must forward native calls (streamed) rather
// than dropping them.
function geminiNativeOnly(): AssistantMessageEventStream {
	return drive((push, out) => {
		const thinking: ThinkingContent = { type: "thinking", thinking: "Checking the todo list." };
		out.content.push(thinking);
		push({ type: "thinking_start", contentIndex: 0, partial: out });
		push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial: out });
		push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: out });
		const block: ToolCall = { type: "toolCall", id: "tool_todo_abc", name: "todo", arguments: {} };
		out.content.push(block);
		push({ type: "toolcall_start", contentIndex: 1, partial: out });
		push({ type: "toolcall_delta", contentIndex: 1, delta: '{"ops":[{"op":"view"}]}', partial: out });
		block.arguments = { ops: [{ op: "view" }] };
		push({ type: "toolcall_end", contentIndex: 1, toolCall: block, partial: out });
	});
}

// A nameless native "ghost" part (Gemini emits these beside a real call) must be
// dropped, while the real native call is still forwarded.
function ghostThenRealNative(): AssistantMessageEventStream {
	return drive((push, out) => {
		const ghost: ToolCall = { type: "toolCall", id: "", name: "", arguments: {} };
		out.content.push(ghost);
		push({ type: "toolcall_start", contentIndex: 0, partial: out });
		push({ type: "toolcall_end", contentIndex: 0, toolCall: ghost, partial: out });
		const real: ToolCall = {
			type: "toolCall",
			id: "tool_todo_real",
			name: "todo",
			arguments: { ops: [{ op: "view" }] },
		};
		out.content.push(real);
		push({ type: "toolcall_start", contentIndex: 1, partial: out });
		push({ type: "toolcall_end", contentIndex: 1, toolCall: real, partial: out });
	});
}

// The duplicate-call report: Gemini writes a real in-band `tool_code` call AND
// also emits a native `functionCall`. Exactly one call must survive — the
// channel lock dedupes structurally, never by guessing from emptiness.
function inbandPlusNative(): AssistantMessageEventStream {
	return drive((push, out) => {
		const text = 'Sure.\n```tool_code\ndefault_api.todo(ops=[{"op": "view"}])\n```\n';
		const textBlock = { type: "text" as const, text };
		out.content.push(textBlock);
		push({ type: "text_delta", contentIndex: 0, delta: text, partial: out });
		const nativeDup: ToolCall = {
			type: "toolCall",
			id: "tool_todo_native",
			name: "todo",
			arguments: { ops: [{ op: "view" }] },
		};
		out.content.push(nativeDup);
		push({ type: "toolcall_start", contentIndex: 1, partial: out });
		push({ type: "toolcall_end", contentIndex: 1, toolCall: nativeDup, partial: out });
	});
}

async function collect(stream: AssistantMessageEventStream): Promise<{ message: AssistantMessage; events: string[] }> {
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { message: await stream.result(), events };
}

describe("wrapInbandToolStream native tool-call passthrough", () => {
	it("streams a provider-native tool call that arrives without in-band text", async () => {
		const { message, events } = await collect(wrapInbandToolStream(geminiNativeOnly(), TOOLS, "gemini"));

		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.id).toBe("tool_todo_abc");
		expect(calls[0]!.arguments).toEqual({ ops: [{ op: "view" }] });
		// Reasoning is preserved alongside the forwarded call.
		expect(message.content.some(b => b.type === "thinking")).toBe(true);
		// A turn with a tool call is "toolUse", never a content-less "stop".
		expect(message.stopReason).toBe("toolUse");
		// The full lifecycle streams live (not materialized in one shot at the end).
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_delta");
		expect(events).toContain("toolcall_end");
	});

	it("drops a nameless native ghost but keeps the real native call", async () => {
		const { message } = await collect(wrapInbandToolStream(ghostThenRealNative(), TOOLS, "gemini"));
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.id).toBe("tool_todo_real");
	});

	it("emits exactly one call when the model uses both the in-band and native channels", async () => {
		const { message } = await collect(wrapInbandToolStream(inbandPlusNative(), TOOLS, "gemini"));
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		// No double-dispatch, regardless of which channel won the lock.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.arguments).toEqual({ ops: [{ op: "view" }] });
	});
});
