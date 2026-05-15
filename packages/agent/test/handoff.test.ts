import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { AUTO_HANDOFF_THRESHOLD_FOCUS, generateHandoff, renderHandoffPrompt } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolCall } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getTestModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected built-in anthropic model to exist");
	}
	return model;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handoff helpers", () => {
	test("renders custom focus into the handoff prompt", () => {
		const rendered = renderHandoffPrompt("preserve failing test name");
		expect(rendered).toContain("Write a handoff document");
		expect(rendered).toContain("Additional focus: preserve failing test name");
	});

	test("exports the threshold focus text used by auto-handoff", () => {
		expect(AUTO_HANDOFF_THRESHOLD_FOCUS).toBe(
			"Threshold-triggered maintenance: preserve critical implementation state and immediate next actions.",
		);
	});

	test("generates handoff with the live cache prefix and tool use disabled", async () => {
		const strayToolCall: ToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(
				createAssistantMessage([
					{ type: "text", text: "## Goal\nContinue" },
					strayToolCall,
					{ type: "text", text: "## Next Steps\n1. Run the focused test" },
				]),
			);
		const model = getTestModel();
		const systemPrompt = ["Live system prompt"];
		const tools: AgentTool[] = [];
		const messages: AgentMessage[] = [
			{ role: "user", content: "start work", timestamp: 1 },
			createAssistantMessage([{ type: "text", text: "started" }]),
		];

		const document = await generateHandoff(messages, model, "test-key", {
			systemPrompt,
			tools,
			customInstructions: "preserve failing test name",
			initiatorOverride: "agent",
			metadata: { session: "handoff-test" },
		});

		expect(document).toBe("## Goal\nContinue\n## Next Steps\n1. Run the focused test");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const call = completeSimpleSpy.mock.calls[0];
		if (!call) throw new Error("Expected completeSimple call");
		const [calledModel, context, options] = call;
		expect(calledModel).toBe(model);
		expect(context.systemPrompt).toBe(systemPrompt);
		expect(context.tools).toBe(tools);
		expect(context.messages[0]).toMatchObject({ role: "user", content: "start work" });
		expect(options).toMatchObject({
			apiKey: "test-key",
			reasoning: Effort.High,
			toolChoice: "none",
			initiatorOverride: "agent",
			metadata: { session: "handoff-test" },
		});

		const lastMessage = context.messages[context.messages.length - 1];
		if (!lastMessage) throw new Error("Expected trailing handoff prompt message");
		if (lastMessage.role !== "user") {
			throw new Error("Expected trailing handoff prompt to be a user message");
		}
		expect(lastMessage.attribution).toBe("agent");
		if (!Array.isArray(lastMessage.content)) {
			throw new Error("Expected handoff prompt content blocks");
		}
		const promptBlock = lastMessage.content[0];
		if (promptBlock?.type !== "text") {
			throw new Error("Expected text handoff prompt block");
		}
		expect(promptBlock.text).toContain("Write a handoff document");
		expect(promptBlock.text).toContain("Additional focus: preserve failing test name");
	});
});
