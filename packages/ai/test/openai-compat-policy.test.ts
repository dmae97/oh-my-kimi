import { describe, expect, it } from "bun:test";
import type { ResponseCreateParamsStreaming, ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	applyChatCompletionsCompatPolicy,
	applyResponsesCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model, ModelSpec, OpenAICompat } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function chatModel(compat: OpenAICompat): Model<"openai-completions"> {
	return buildModel({
		id: "compat-reasoner",
		name: "Compat Reasoner",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies ModelSpec<"openai-completions">);
}

function responsesModel(compat: OpenAICompat): Model<"openai-responses"> {
	return buildModel({
		id: "compat-reasoner",
		name: "Compat Reasoner",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies ModelSpec<"openai-responses">);
}

function chatParams(): OpenAICompletionsParams {
	return { model: "compat-reasoner", messages: [], stream: true };
}

function responsesParams(): ResponseCreateParamsStreaming {
	return { model: "compat-reasoner", input: [], stream: true };
}

describe("OpenAI compat policy", () => {
	it("suppresses reasoning on forced tool choice for both endpoints", () => {
		const compat: OpenAICompat = {
			disableReasoningOnForcedToolChoice: true,
			thinkingFormat: "openrouter",
			reasoningDisableMode: "openrouter-enabled-false",
		};
		const toolChoice = { type: "function", name: "search" };
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), {
			endpoint: "chat-completions",
			reasoning: Effort.High,
			toolChoice,
		});
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), {
			endpoint: "responses",
			reasoning: Effort.High,
			toolChoice,
		});

		expect(chatPolicy.reasoning.enabled).toBe(false);
		expect(responsesPolicy.reasoning.enabled).toBe(false);
		expect(chatPolicy.reasoning.disableReason).toBe("forced-tool-choice");
		expect(responsesPolicy.reasoning.disableReason).toBe("forced-tool-choice");
	});

	it("encodes OpenRouter disabled reasoning through both wire adapters", () => {
		const compat: OpenAICompat = {
			thinkingFormat: "openrouter",
			reasoningDisableMode: "openrouter-enabled-false",
		};
		const chatBody = chatParams();
		const responseBody = responsesParams();
		const responseInput: ResponseInput = [];

		applyChatCompletionsCompatPolicy(
			chatBody,
			resolveOpenAICompatPolicy(chatModel(compat), {
				endpoint: "chat-completions",
				disableReasoning: true,
			}),
		);
		applyResponsesCompatPolicy(
			responseBody,
			responseInput,
			resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses", disableReasoning: true }),
			undefined,
		);

		expect(chatBody.reasoning).toEqual({ enabled: false });
		expect(responseBody.reasoning as unknown).toEqual({ enabled: false });
	});

	it("omits effort for both wire adapters from one catalog flag", () => {
		const compat: OpenAICompat = { omitReasoningEffort: true };
		const chatBody = chatParams();
		const responseBody = responsesParams();
		const responseInput: ResponseInput = [];

		applyChatCompletionsCompatPolicy(
			chatBody,
			resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		applyResponsesCompatPolicy(
			responseBody,
			responseInput,
			resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses", reasoning: Effort.High }),
			undefined,
		);

		expect(chatBody.reasoning_effort).toBeUndefined();
		expect(responseBody.reasoning).toBeUndefined();
	});

	it("uses a non-budget fallback prompt for Responses no-reasoning compat", () => {
		const compat: OpenAICompat = { requiresReasoningSuppressionPrompt: true };
		const responseBody = responsesParams();
		const responseInput: ResponseInput = [];

		const appended = applyResponsesCompatPolicy(
			responseBody,
			responseInput,
			resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses" }),
			undefined,
		);

		expect(appended).toBe(1);
		expect(responseInput.at(-1)).toEqual({
			role: "developer",
			content: [
				{
					type: "input_text",
					text: "Keep internal reasoning brief. Continue following the task and use tools normally.",
				},
			],
		});
	});

	it("exposes reasoning replay constraints independent of endpoint", () => {
		const compat: OpenAICompat = {
			requiresReasoningContentForToolCalls: true,
			requiresReasoningContentForAllAssistantTurns: true,
			allowsSyntheticReasoningContentForToolCalls: false,
			reasoningContentField: "reasoning_content",
		};
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions" });
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses" });

		expect(chatPolicy.reasoning.requiresReasoningContentForToolCalls).toBe(true);
		expect(responsesPolicy.reasoning.requiresReasoningContentForToolCalls).toBe(true);
		expect(chatPolicy.reasoning.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(responsesPolicy.reasoning.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(chatPolicy.reasoning.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(responsesPolicy.reasoning.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	it("exposes tool id and cumulative reasoning stream constraints for both endpoints", () => {
		const compat: OpenAICompat = { requiresMistralToolIds: true, reasoningDeltasMayBeCumulative: true };
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions" });
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses" });

		expect(chatPolicy.tools.toolCallIdKind).toBe("mistral-9-alnum");
		expect(responsesPolicy.tools.toolCallIdKind).toBe("mistral-9-alnum");
		expect(chatPolicy.stream.reasoningDeltasMayBeCumulative).toBe(true);
		expect(responsesPolicy.stream.reasoningDeltasMayBeCumulative).toBe(true);
	});
});
