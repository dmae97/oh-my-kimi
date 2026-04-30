import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { convertMessages, detectCompat } from "../src/providers/openai-completions";
import type { AssistantMessage, Model } from "../src/types";

function deepseekModel(overrides: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		reasoning: true,
		...overrides,
	};
}

function assistantWithToolCall(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Calling a tool." },
			{
				type: "toolCall",
				id: "call_repro_1",
				name: "list_files",
				arguments: { path: "." },
			},
		],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("issue #883 / #810 — DeepSeek V4 reasoning_content tool-call replay", () => {
	it("flags requiresReasoningContentForToolCalls for deepseek-v4-pro on the official endpoint", () => {
		const compat = detectCompat(
			deepseekModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				id: "deepseek-v4-pro",
			}),
		);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("flags requiresReasoningContentForToolCalls for deepseek-v4 served by a non-deepseek host (e.g. Deepinfra)", () => {
		const compat = detectCompat(
			deepseekModel({
				provider: "deepinfra",
				baseUrl: "https://api.deepinfra.com/v1/openai",
				id: "deepseek-ai/DeepSeek-V4-Flash",
			}),
		);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("injects reasoning_content placeholder on assistant tool-call turn for deepseek-v4-pro", () => {
		const model = deepseekModel({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			id: "deepseek-v4-pro",
		});
		const compat = detectCompat(model);
		const messages = convertMessages(model, { messages: [assistantWithToolCall(model)] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const reasoningContent = Reflect.get(assistant as object, "reasoning_content");
		expect(typeof reasoningContent).toBe("string");
		expect((reasoningContent as string).length).toBeGreaterThan(0);
	});

	it("normalizes assistant content to '' when reasoning_content placeholder is injected (DeepSeek invariant)", () => {
		const model = deepseekModel({
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			id: "deepseek-ai/DeepSeek-V4-Pro",
		});
		const compat = detectCompat(model);
		// Assistant turn whose only content is a tool call (no text) - matches what the SDK
		// produces after a pure tool-use turn. content must end up "" (not null) because
		// DeepSeek rejects null content alongside reasoning_content.
		const toolOnly: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_repro_2",
					name: "list_files",
					arguments: { path: "." },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [toolOnly] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as { content: unknown }).content).toBe("");
	});
});
