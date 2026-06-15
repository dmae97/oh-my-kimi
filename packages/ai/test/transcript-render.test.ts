import { describe, expect, it } from "bun:test";
import type { Message, Usage } from "@oh-my-pi/pi-ai";
import { type Dialect, getDialectDefinition } from "@oh-my-pi/pi-ai/dialect";

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const messages: Message[] = [
	{ role: "user", content: "Find pi", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "I should search." },
			{ type: "text", text: "Searching." },
			{ type: "toolCall", id: "call-1", name: "search", arguments: { query: "pi" } },
		],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "search",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 3,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: usage(),
		stopReason: "stop",
		timestamp: 4,
	},
];

describe("dialect transcript rendering", () => {
	it("renders harmony turns with analysis, final, calls, and tool results", () => {
		const out = getDialectDefinition("harmony").renderTranscript(messages);

		expect(out).toContain("<|start|>user<|message|>Find pi<|end|>");
		expect(out).toContain("<|start|>assistant<|channel|>analysis<|message|>I should search.<|end|>");
		expect(out).toContain("<|start|>assistant<|channel|>final<|message|>Searching.<|end|>");
		expect(out).toContain("to=functions.search");
		expect(out).toContain("<|start|>functions.search to=assistant<|channel|>commentary<|message|>result<|end|>");
	});

	it("renders qwen3 ChatML turns with thinking and user tool-result turns", () => {
		const out = getDialectDefinition("qwen3").renderTranscript(messages);

		expect(out).toContain("<|im_start|>assistant\n<think>\nI should search.\n</think>");
		expect(out).toContain("<|im_start|>user\n<tool_response>\nresult\n</tool_response><|im_end|>\n");
		expect(out).not.toContain("[User]:");
	});

	it("renders GLM turns with BOS and observation result turns", () => {
		const out = getDialectDefinition("glm").renderTranscript(messages);

		expect(out).toStartWith("[gMASK]<sop>");
		expect(out).toContain("<|assistant|>\n\n<think>\nI should search.\n</think>");
		expect(out).toContain("<|observation|>\n<tool_response>\nresult\n</tool_response>");
	});

	it("renders anthropic legacy Human and Assistant turns", () => {
		const out = getDialectDefinition("anthropic").renderTranscript(messages);

		expect(out).toContain("\n\nHuman: Find pi");
		expect(out).toContain("\n\nAssistant: <thinking>\nI should search.\n</thinking>");
		expect(out).toContain("<function_calls>");
		expect(out).toContain("<function_results>");
		expect(out).not.toContain("[Assistant tool calls]:");
	});

	it("renders distinct native text for each sampled dialect", () => {
		const outputs = (["harmony", "qwen3", "glm", "anthropic"] satisfies readonly Dialect[]).map(dialect =>
			getDialectDefinition(dialect).renderTranscript(messages),
		);

		expect(new Set(outputs).size).toBe(outputs.length);
	});
});
