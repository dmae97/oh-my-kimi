import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression: Anthropic-compatible reasoning endpoints often emit `thinking`
 * blocks without a first-party Anthropic signature, but still expect those
 * blocks back as native `type: "thinking"` on continuation. Demoting unsigned
 * thinking to text strips the reasoning chain and can destabilize follow-up
 * tool-call argument serialization (the upstream cause behind #2005's `todo`
 * renderer crash).
 *
 * Official Anthropic remains conservative: unsigned thinking is demoted to text
 * there because the first-party API enforces signature-based integrity.
 */
function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-anthropic",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text = "continue"): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistantThinking(thinking: string, tail: AssistantMessage["content"][number][] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature: "" }, ...tail],
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: "reasoning-model",
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
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock = WireThinkingBlock | WireTextBlock | WireToolUseBlock | { type: string; [key: string]: unknown };

function assistantWireBlocks(messages: Message[], model: Model<"anthropic-messages">): WireBlock[] {
	const params = convertAnthropicMessages(messages, model, false);
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

describe("Anthropic-compatible unsigned thinking replay (#2005)", () => {
	it("preserves unsigned thinking for non-official reasoning endpoints", () => {
		const blocks = assistantWireBlocks(
			[
				makeUser("solve x"),
				makeAssistantThinking("plan: read the file, then edit", [{ type: "text", text: "Sure." }]),
			],
			makeModel(),
		);
		expect(blocks[0]).toEqual({
			type: "thinking",
			thinking: "plan: read the file, then edit",
			signature: "",
		});
		expect(blocks[1]).toEqual({ type: "text", text: "Sure." });
	});

	it("sanitizes lone surrogates in cross-API tool arguments only", () => {
		const loneSurrogate = "broken \ud83d end";
		const makeToolCallAssistant = (api: AssistantMessage["api"]): AssistantMessage => ({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "write",
					arguments: { text: loneSurrogate, nested: { parts: [loneSurrogate] } },
				},
			],
			api,
			provider: api === "anthropic-messages" ? "custom-anthropic" : "openai",
			model: "reasoning-model",
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
		});

		// Cross-API replay: Anthropic's strict UTF-8 validation rejects lone
		// surrogates, so string leaves are deep-sanitized.
		const crossBlocks = assistantWireBlocks([makeUser(), makeToolCallAssistant("openai-responses")], makeModel());
		const crossToolUse = crossBlocks.find(block => block.type === "tool_use") as WireToolUseBlock;
		expect(crossToolUse.input.text).toBe("broken \ufffd end");
		expect((crossToolUse.input.nested as { parts: string[] }).parts[0]).toBe("broken \ufffd end");

		// Same-API replay stays byte-identical (the args came from Anthropic's own
		// JSON; rewriting them would destabilize prompt-cache prefixes).
		const sameBlocks = assistantWireBlocks([makeUser(), makeToolCallAssistant("anthropic-messages")], makeModel());
		const sameToolUse = sameBlocks.find(block => block.type === "tool_use") as WireToolUseBlock;
		expect(sameToolUse.input.text).toBe(loneSurrogate);
	});

	it("covers the Xiaomi MiMo Anthropic-compatible reporter configuration without provider allowlists", () => {
		const model = makeModel({
			provider: "user-custom",
			id: "mimo-v2.5-pro",
			name: "MiMo V2.5 Pro (Singapore)",
			baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
			maxTokens: 131_072,
			contextWindow: 1_048_576,
		});
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("hidden reasoning")], model);
		expect(blocks[0]).toEqual({ type: "thinking", thinking: "hidden reasoning", signature: "" });
	});

	it("preserves legacy known non-signing endpoints even if model.reasoning is false", () => {
		const model = makeModel({ provider: "custom", baseUrl: "https://api.deepseek.com/v1", reasoning: false });
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("deepseek reasoning")], model);
		expect(blocks[0]?.type).toBe("thinking");
	});

	it("still degrades unsigned thinking to text for official Anthropic", () => {
		const model = makeModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" });
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("internal scratch")], model);
		expect(blocks[0]?.type).toBe("text");
		expect((blocks[0] as WireTextBlock).text).toBe("internal scratch");
	});

	it("treats a missing baseUrl as official Anthropic (resolveAnthropicBaseUrl default)", () => {
		// `isOfficialAnthropicApiUrl(undefined) === true` because the actual HTTP
		// dispatch falls back to https://api.anthropic.com. Same-id custom
		// overrides that only tweak model metadata (no baseUrl override) must
		// not regress to native-thinking replay against the first-party API.
		const model = makeModel({ provider: "anthropic", baseUrl: "" });
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("internal scratch")], model);
		expect(blocks[0]?.type).toBe("text");
		expect((blocks[0] as WireTextBlock).text).toBe("internal scratch");
	});

	it("still degrades unsigned thinking to text for non-reasoning unknown endpoints", () => {
		const model = makeModel({ reasoning: false, baseUrl: "https://plain.example.com/anthropic" });
		const blocks = assistantWireBlocks([makeUser(), makeAssistantThinking("scratch")], model);
		expect(blocks[0]?.type).toBe("text");
		expect((blocks[0] as WireTextBlock).text).toBe("scratch");
	});

	it("keeps thinking → tool_use pairing intact across continuation conversion", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_reasoning_1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 0,
		};
		const model = makeModel();
		const messages: Message[] = [
			makeUser("read README"),
			makeAssistantThinking("I need to call the read tool", [
				{ type: "toolCall", id: "toolu_reasoning_1", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult,
		];
		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user"]);
		const assistantBlocks = params[1].content as WireBlock[];
		expect(assistantBlocks[0]?.type).toBe("thinking");
		expect(assistantBlocks[1]?.type).toBe("tool_use");
		expect((assistantBlocks[1] as WireToolUseBlock).id).toBe("toolu_reasoning_1");
	});
});
