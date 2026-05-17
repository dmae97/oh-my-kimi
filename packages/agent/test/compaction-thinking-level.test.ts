import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { generateHandoff } from "@oh-my-pi/pi-agent-core/compaction";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";

// Pins fix #1 of the compaction effort-override bug. Before this fix,
// `generateHandoff` (and the three other compaction summarizers) hardcoded
// `reasoning: Effort.High`, ignoring the user's `/model` thinking selection.
// On a model with `compat.supportsReasoningEffort: false` (xai-oauth/grok-build),
// this produced "Compaction failed: Thinking effort high is not supported by
// xai-oauth/grok-build" — but the underlying defect (silent user-intent
// override) was present on every model, just invisible because most models
// silently accept the override.
//
// `resolveCompactionEffort` is the per-call resolver:
// - `Off`              → `undefined` (user said no thinking; honored)
// - `undefined`/`Inherit` → `Effort.High` default → clamped per model
// - explicit Effort    → respect it → clamped per model
//
// `generateHandoff` is chosen as the test vehicle because it issues exactly
// one LLM call per invocation (simpler to assert than `compact()` which fans
// out into summary + short-summary + turn-prefix). The contract under test
// (`resolveCompactionEffort`) is shared across all four call sites in
// `packages/agent/src/compaction/compaction.ts`.

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

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

function getGrokBuildModel(): Model {
	const model = getBundledModel("xai-oauth", "grok-build");
	if (!model) throw new Error("Expected built-in xai-oauth/grok-build to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "start work", timestamp: 1 },
	createAssistantMessage([{ type: "text", text: "started" }]),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction thinking-level resolution (regression)", () => {
	test("undefined thinkingLevel on Anthropic → reasoning=high (historical default preserved)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			// thinkingLevel omitted — must default to high
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.High);
	});

	test("ThinkingLevel.Off on Anthropic → reasoning=undefined (user intent honored)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Off,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		// Codex-caught defect: Off MUST NOT be silently coerced to High.
		expect(call[2]?.reasoning).toBeUndefined();
	});

	test("ThinkingLevel.Low on Anthropic → reasoning=low (explicit user choice)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Low,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.Low);
	});

	test("ThinkingLevel.High on xai-oauth/grok-build → reasoning=undefined (clamp)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getGrokBuildModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.High,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		// clampThinkingLevelForModel(grokBuild, High) === undefined because
		// supportsReasoningEffort: false ⇒ getSupportedEfforts returns [] ⇒
		// no clamp target. The omitReasoningEffort gate at the wire layer is
		// the actual strip; this just ensures the upstream throw doesn't fire.
		expect(call[2]?.reasoning).toBeUndefined();
	});

	test("ThinkingLevel.Inherit on Anthropic → reasoning=high (Inherit folds to historical default)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Inherit,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.High);
	});
});
