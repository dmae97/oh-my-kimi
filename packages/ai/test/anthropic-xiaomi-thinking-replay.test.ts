import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";

/**
 * Regression: Xiaomi MiMo's Anthropic-compat endpoint
 * (`token-plan-*.xiaomimimo.com/anthropic`, `api.xiaomimimo.com/anthropic`)
 * emits `thinking` blocks WITHOUT a `signature`. Before #2005, the conversion
 * layer treated any unknown Anthropic endpoint as signing-capable, so those
 * unsigned thinking blocks got demoted to `type: "text"` on replay. With the
 * reasoning chain stripped, MiMo's next continuation surfaced malformed tool
 * arguments (e.g. `todo.ops` arriving as a JSON-string), triggering the
 * downstream renderer crash and retry-spam reported in #2005.
 *
 * Now that `isNonSigningAnthropicEndpoint` recognizes the Xiaomi family,
 * unsigned `thinking` blocks must round-trip as `{ type: "thinking", signature: "" }`.
 */
function makeXiaomiModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		provider: "xiaomi-token-plan-sgp",
		id: "mimo-v2.5-pro",
		name: "MiMo V2.5 Pro (Singapore)",
		baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		reasoning: true,
		...overrides,
	};
}

function makeUser(text = "continue"): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistantThinking(thinking: string, tail: AssistantMessage["content"][number][] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature: "" }, ...tail],
		api: "anthropic-messages",
		provider: "xiaomi-token-plan-sgp",
		model: "mimo-v2.5-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

interface WireThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}
interface WireTextBlock {
	type: "text";
	text: string;
}
type WireBlock = WireThinkingBlock | WireTextBlock | { type: string; [key: string]: unknown };

function assistantWireBlocks(messages: Message[], model: Model<"anthropic-messages">): WireBlock[] {
	const params = convertAnthropicMessages(messages, model, false);
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

describe("Xiaomi MiMo Anthropic-compat thinking replay (#2005)", () => {
	it("preserves unsigned thinking blocks as type:'thinking' for xiaomi-token-plan-sgp", () => {
		const blocks = assistantWireBlocks(
			[
				makeUser("solve x"),
				makeAssistantThinking("plan: read the file, then edit", [{ type: "text", text: "Sure." }]),
			],
			makeXiaomiModel(),
		);
		// Critical: a `thinking` block survives — without the fix it would have
		// been demoted to a `text` block and the model would replay garbled args.
		expect(blocks[0]).toEqual({
			type: "thinking",
			thinking: "plan: read the file, then edit",
			signature: "",
		});
		expect(blocks[1]).toEqual({ type: "text", text: "Sure." });
	});

	it("preserves unsigned thinking for every Token Plan region (ams, cn) and api.xiaomimimo.com", () => {
		for (const baseUrl of [
			"https://token-plan-ams.xiaomimimo.com/anthropic",
			"https://token-plan-cn.xiaomimimo.com/anthropic",
			"https://api.xiaomimimo.com/anthropic",
		]) {
			const model = makeXiaomiModel({ baseUrl, provider: "user-custom" });
			const blocks = assistantWireBlocks(
				[makeUser(), makeAssistantThinking("hidden reasoning")],
				model,
			);
			expect(blocks[0]?.type).toBe("thinking");
			expect((blocks[0] as WireThinkingBlock).thinking).toBe("hidden reasoning");
		}
	});

	it("still degrades unsigned thinking to text for unknown signing-capable endpoints", () => {
		// Sanity guard: don't flip the default for, e.g., api.anthropic.com.
		const anthropicModel: Model<"anthropic-messages"> = {
			...makeXiaomiModel(),
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			id: "claude-sonnet-4-6",
		};
		const blocks = assistantWireBlocks(
			[makeUser(), makeAssistantThinking("internal scratch")],
			anthropicModel,
		);
		expect(blocks[0]?.type).toBe("text");
		expect((blocks[0] as WireTextBlock).text).toBe("internal scratch");
	});

	it("keeps thinking → tool_use pairing intact across the conversion (continuation contract)", () => {
		// The original failure mode: continuation request after a tool call.
		// Thinking must precede `tool_use`, both must survive, and the
		// `tool_result` must follow as the next user turn.
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_xiaomi_1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 0,
		};
		const model = makeXiaomiModel();
		const messages: Message[] = [
			makeUser("read README"),
			makeAssistantThinking("I need to call the read tool", [
				{ type: "toolCall", id: "toolu_xiaomi_1", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult,
		];
		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user"]);
		const assistantBlocks = params[1].content as WireBlock[];
		expect(assistantBlocks[0]?.type).toBe("thinking");
		expect(assistantBlocks[1]?.type).toBe("tool_use");
		expect((assistantBlocks[1] as { id: string }).id).toBe("toolu_xiaomi_1");
	});
});
