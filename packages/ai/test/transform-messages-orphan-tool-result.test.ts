import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";

const model = {
	id: "k3",
	name: "k3",
	api: "openai-completions",
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
} as Model<"openai-completions">;

function assistantWithTool(id: string, stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: "bash",
				arguments: { command: "echo hi" },
			},
		],
		api: "openai-completions",
		provider: "kimi-coding",
		model: "k3",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function toolResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "hi" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("transformMessages orphan toolResult drop (Kimi/K3)", () => {
	it("Given an errored assistant with toolCall is dropped, When toolResult remains, Then orphan result is removed", () => {
		const messages: Message[] = [
			{ role: "user", content: "run bash", timestamp: Date.now() },
			assistantWithTool("call_alive", "toolUse"),
			toolResult("call_alive"),
			// Failed turn: assistant error is dropped, but historically its toolResult stayed → K3 400
			{ ...assistantWithTool("call_dead", "error"), errorMessage: "terminated" },
			toolResult("call_dead"),
			{ role: "user", content: "continue", timestamp: Date.now() },
		];

		const result = transformMessages(messages, model);
		const toolResults = result.filter((m) => m.role === "toolResult") as ToolResultMessage[];
		const ids = toolResults.map((m) => m.toolCallId);

		expect(ids).toContain("call_alive");
		expect(ids).not.toContain("call_dead");
		// No assistant with stopReason error in replay
		expect(result.some((m) => m.role === "assistant" && (m as AssistantMessage).stopReason === "error")).toBe(false);
	});

	it("Given empty tool_call_id result, When transformed, Then it is dropped", () => {
		const messages: Message[] = [
			{ role: "user", content: "x", timestamp: Date.now() },
			assistantWithTool("call_ok", "toolUse"),
			{ ...toolResult("call_ok") },
			{ ...toolResult("   "), toolCallId: "   " },
		];
		const result = transformMessages(messages, model);
		const ids = result.filter((m) => m.role === "toolResult").map((m) => (m as ToolResultMessage).toolCallId);
		expect(ids).toEqual(["call_ok"]);
	});

	it("still synthesizes missing results for kept assistants", () => {
		const messages: Message[] = [
			{ role: "user", content: "x", timestamp: Date.now() },
			assistantWithTool("call_pending", "toolUse"),
			{ role: "user", content: "never mind", timestamp: Date.now() },
		];
		const result = transformMessages(messages, model);
		const synthetic = result.filter(
			(m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "call_pending",
		) as ToolResultMessage[];
		expect(synthetic).toHaveLength(1);
		expect(synthetic[0].isError).toBe(true);
	});
});
