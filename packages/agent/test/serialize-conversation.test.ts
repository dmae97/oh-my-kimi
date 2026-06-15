import { describe, expect, test } from "bun:test";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResultMessage(toolCallId: string, text: string, extra: Partial<ToolResultMessage> = {}): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "search",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
		...extra,
	};
}

describe("serializeConversation — useless pairs", () => {
	test("skips a useless-flagged tool call/result pair but keeps its sibling", () => {
		const out = serializeConversation([
			assistantMessage([
				{ type: "toolCall", id: "c-keep", name: "search", arguments: { pattern: "alpha" } },
				{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
			]),
			toolResultMessage("c-keep", "alpha match found in src/alpha.ts"),
			toolResultMessage("c-drop", "No matches found", { useless: true }),
		]);

		expect(out).toContain('pattern="alpha"');
		expect(out).toContain("alpha match found in src/alpha.ts");
		expect(out).not.toContain("zzz_nothing");
		expect(out).not.toContain("No matches found");
	});

	test("error results stay serialized even when flagged useless", () => {
		const out = serializeConversation([
			assistantMessage([{ type: "toolCall", id: "c-err", name: "search", arguments: { pattern: "beta" } }]),
			toolResultMessage("c-err", "grep crashed", { useless: true, isError: true }),
		]);

		expect(out).toContain('pattern="beta"');
		expect(out).toContain("[Tool Result]: grep crashed");
	});
});
