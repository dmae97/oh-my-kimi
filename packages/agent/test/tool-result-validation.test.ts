import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
} from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { parseJsonValue } from "../src/tool-execution-boundary.ts";
import type { AgentEvent, AgentMessage, AgentTool, AgentToolResult } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected assistant event");
			},
		);
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function isModelMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function streamToolTurn() {
	let request = 0;
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const first = request++ === 0;
			const message = first
				? assistant([{ type: "toolCall", id: "call-1", name: "invalid", arguments: { value: "x" } }], "toolUse")
				: assistant([{ type: "text", text: "done" }], "stop");
			stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
		});
		return stream;
	};
}

function toolResults(messages: readonly AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("tool result validation boundary", () => {
	it("preserves and detaches plain JSON values", () => {
		const value = { nested: [1, "two", true, null] };
		const parsed = parseJsonValue(value);
		expect(parsed).toEqual(value);
		expect(parsed.nested).not.toBe(value.nested);
	});

	it.each([
		["Map", () => Object.setPrototypeOf(new Map(), Object.prototype)],
		["Set", () => Object.setPrototypeOf(new Set(), Object.prototype)],
		["Date", () => Object.setPrototypeOf(new Date(), Object.prototype)],
		["DataView", () => Object.setPrototypeOf(new DataView(new ArrayBuffer(1)), Object.prototype)],
		["typed array", () => Object.setPrototypeOf(new Uint8Array(1), Object.prototype)],
		["SharedArrayBuffer", () => Object.setPrototypeOf(new SharedArrayBuffer(1), Object.prototype)],
		[
			"cycle",
			() => {
				const value: Record<string, unknown> = {};
				value.self = value;
				return value;
			},
		],
	] as const)("rejects prototype-masked intrinsic or %s JSON values at parse", (_name, createValue) => {
		expect(() => parseJsonValue({ value: createValue() })).toThrow(TypeError);
	});

	it.each(["content", "details"] as const)(
		"converts invalid started %s into one failed terminal before lifecycle end",
		async (field) => {
			// Given: a tool that resolves with cyclic content or a prototype-masked intrinsic detail.
			const schema = Type.Object({ value: Type.String() });
			const tool: AgentTool<typeof schema, unknown> = {
				name: "invalid",
				label: "Invalid",
				description: "Returns invalid data",
				parameters: schema,
				async execute() {
					const result: AgentToolResult<unknown> = {
						content: [{ type: "text", text: "ok" }],
						details: {},
					};
					if (field === "content") {
						const cyclic: Record<string, unknown> = {};
						cyclic.self = cyclic;
						Reflect.set(result, "content", [cyclic]);
					} else {
						Reflect.set(result, "details", Object.setPrototypeOf(new Map([["x", 1]]), Object.prototype));
					}
					return result;
				},
			};
			const events: AgentEvent[] = [];

			// When: the loop commits the resolved execution.
			const messages = await runAgentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [tool] },
				{ model, convertToLlm: (items) => items.filter(isModelMessage) },
				(event) => {
					events.push(event);
				},
				undefined,
				streamToolTurn(),
			);

			// Then: one started lifecycle closes with one executor-owned failed result.
			const results = toolResults(messages);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				toolCallId: "call-1",
				isError: true,
				details: { omk: { disposition: "failed", synthetic: true, executionStarted: true } },
			});
			expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
			expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
			expect(
				events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
			).toHaveLength(1);
		},
	);
});
