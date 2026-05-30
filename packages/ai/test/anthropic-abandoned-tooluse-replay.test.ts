import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";

// These tests pin the wire-validity contract that was verified end-to-end against the
// live Anthropic Messages API (claude-opus-4-8):
//
//   * A `thinking` block sent back to Anthropic MUST carry a non-empty signature, or the
//     request 400s ("thinking.signature: Field required" for a missing one,
//     "Invalid `signature` in `thinking` block" for a stale one).
//   * `stop_reason` is never replayed on the wire, so it does NOT constrain whether a
//     continuation is valid — a tool_use turn replays fine with tool_results appended
//     whether it ended on `tool_use` or `end_turn`.
//   * Therefore the safe recovery for a historical turn whose signature is untrustworthy
//     (abandoned `end_turn`+tool_use, or a half-streamed `aborted` turn) is to strip the
//     signature and let the encoder downgrade the block to text — which the API accepts.
//   * The latest assistant message is different: Anthropic requires thinking blocks from
//     its most recent response to remain unmodified, so valid signatures must be preserved
//     even when the turn is abandoned.
//
// The agent loop relies on this: it now runs tool_use blocks under `stop`/`end_turn` and
// continues. That continuation is valid only when the transform preserves latest signed
// thinking and downgrades historical/invalid signed thinking.

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildHistory(stopReason: AssistantMessage["stopReason"], signature: string | undefined): Message[] {
	const user: UserMessage = { role: "user", content: "reason, then call the tool", timestamp: 1 };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "deliberating about the forecast", thinkingSignature: signature },
			{ type: "text", text: "I'll check the weather." },
			{ type: "toolCall", id: "toolu_1", name: "get_weather", arguments: { location: "Paris" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: emptyUsage,
		stopReason,
		timestamp: 2,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_1",
		toolName: "get_weather",
		content: [{ type: "text", text: "15C, partly cloudy" }],
		details: {},
		isError: false,
		timestamp: 3,
	};
	return [user, assistant, toolResult];
}

type WireBlock = { type: string; signature?: string; thinking?: string; text?: string };

function assistantBlocks(messages: Message[]): WireBlock[] {
	const params = convertAnthropicMessages(messages, model, false);
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

/** The hard API rule: no thinking block may be emitted without a non-empty signature. */
function expectNoUnsignedThinking(blocks: WireBlock[]): void {
	for (const block of blocks) {
		if (block.type === "thinking") {
			expect(block.signature && block.signature.length > 0).toBeTruthy();
		}
	}
}

describe("Anthropic abandoned/aborted tool-use replay", () => {
	it("preserves signed thinking on a genuine toolUse turn", () => {
		const blocks = assistantBlocks(buildHistory("toolUse", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("preserves signed thinking on the latest end_turn(stop) tool-use turn", () => {
		const blocks = assistantBlocks(buildHistory("stop", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("preserves signed thinking on the latest surviving abandoned tool-use turn when trailing truncated thinking is dropped", () => {
		const blocks = assistantBlocks(buildHistoryWithTrailingTruncatedThinking("stop", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking" && b.signature === "sig_valid")).toBe(true);
		expect(blocks.some(b => b.type === "text" && b.text?.includes("deliberating about the forecast"))).toBe(false);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("downgrades historical end_turn(stop) tool-use thinking to text so the continuation stays wire-valid", () => {
		const blocks = assistantBlocks(buildHistoryWithLaterAssistant("stop", "sig_valid"));
		expectNoUnsignedThinking(blocks);
		// Signature stripped (historical abandoned tool-use) -> encoder downgrades to text.
		expect(blocks.some(b => b.type === "thinking")).toBe(false);
		expect(blocks.some(b => b.type === "text" && b.text?.includes("deliberating"))).toBe(true);
		// tool_use is preserved so it still pairs with the appended tool_result.
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});

	it("recovers a half-streamed aborted turn (partial/invalid signature) by downgrading to text", () => {
		const blocks = assistantBlocks(buildHistory("aborted", "trunc"));
		expectNoUnsignedThinking(blocks);
		expect(blocks.some(b => b.type === "thinking")).toBe(false);
		expect(blocks.some(b => b.type === "tool_use")).toBe(true);
	});
});

function buildHistoryWithLaterAssistant(
	stopReason: AssistantMessage["stopReason"],
	signature: string | undefined,
): Message[] {
	return [
		...buildHistory(stopReason, signature),
		{ role: "user", content: "continue after tool result", timestamp: 4 } satisfies UserMessage,
		{
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 5,
		} satisfies AssistantMessage,
	];
}

function buildHistoryWithTrailingTruncatedThinking(
	stopReason: AssistantMessage["stopReason"],
	signature: string | undefined,
): Message[] {
	const abandonedToolUse = buildHistory(stopReason, signature);
	return [
		abandonedToolUse[0]!,
		abandonedToolUse[1]!,
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "truncated final thought", thinkingSignature: "sig_truncated" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: emptyUsage,
			stopReason: "length",
			timestamp: 4,
		} satisfies AssistantMessage,
	];
}
