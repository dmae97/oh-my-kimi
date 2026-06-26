/**
 * Regression guard for llama.cpp warm-prefix invalidation on auto-learn
 * capture-at-stop and any other assistant continuation (#3528).
 *
 * `omp-llm-request-15179edfab4dc557.json` plus the rr-session captures from the
 * reporter showed:
 *
 *  - System prompt and tool catalogue were byte-stable across requests 3–12.
 *  - Requests 4–11 fully reused the prefix (`cached_tokens` grew from ~36K to
 *    ~38K).
 *  - Request 12 — auto-learn capture-at-stop — added the prior assistant turn
 *    plus the synthetic user nudge, and `cached_tokens` collapsed to 0. Full
 *    prompt re-processing on llama.cpp.
 *
 * The prior assistant turn had streamed `reasoning_content` deltas (Qwen3
 * thinking output). The OMP-side `Context` preserved those as a
 * `{ type: "thinking", thinkingSignature: "reasoning_content" }` block on the
 * assistant message, but `convertMessages` dropped the field when re-serializing
 * for the next request because the llama.cpp compat profile carried none of the
 * existing `requires*ReasoningContent*` / `thinkingFormat === "zai"` flags.
 * Llama.cpp's chat template then re-rendered the assistant turn without
 * `<think>…</think>`, diverging from the slot's existing KV cache and forcing
 * full re-prefill.
 *
 * The fix is the new `compat.replayReasoningContent` flag — auto-enabled for
 * the four built-in local OpenAI-compatible providers and for any provider
 * pointed at a loopback / RFC1918 baseUrl — plus a fourth branch in the
 * `openai-completions` assistant encoder that surfaces preserved thinking as
 * `reasoning_content` on every reasoning-engaged turn (not just tool-call
 * turns). This file pins the wire output across the relevant axes.
 */
import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ModelSpec, ThinkingContent, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
	for (const message of messages) {
		if (isPlainObject(message) && message.role === "assistant") return message;
	}
	return undefined;
}

function llamaCppQwenModel(overrides?: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	// Mirrors the reporter's `qwen-27-mtp-vision-offload` setup: local
	// llama.cpp baseUrl, Qwen-family id, reasoning enabled. Per detectCompat
	// this resolves to `thinkingFormat: "qwen"`, none of the `requires*` flags,
	// and (with this fix) `replayReasoningContent: true`.
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-completions",
		provider: "llama.cpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 131_072,
		...overrides,
	} satisfies ModelSpec<"openai-completions">);
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantWithReasoning(reasoning: string, answer: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "llama.cpp",
		model: "qwen-3.6-27b",
		content: [
			{ type: "thinking", thinking: reasoning, thinkingSignature: "reasoning_content" } satisfies ThinkingContent,
			{ type: "text", text: answer },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("llama.cpp warm-prefix preservation (#3528)", () => {
	it("auto-enables replayReasoningContent for llama.cpp thinking models", () => {
		const compat = llamaCppQwenModel().compat;
		expect(compat.replayReasoningContent).toBe(true);
	});

	it("auto-enables replayReasoningContent for LM Studio and vLLM thinking models", () => {
		// Same `replayReasoningContent` semantics extend to the other built-in
		// local OpenAI-compatible providers — their llama.cpp-style backends
		// share the chat-template KV-cache reuse model.
		const lmStudio = llamaCppQwenModel({ provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }).compat;
		const vllm = llamaCppQwenModel({ provider: "vllm", baseUrl: "http://127.0.0.1:8000/v1" }).compat;
		expect(lmStudio.replayReasoningContent).toBe(true);
		expect(vllm.replayReasoningContent).toBe(true);
	});

	it("auto-enables replayReasoningContent for custom providers on loopback baseUrls", () => {
		// User-defined `provider: "custom"` pointed at a local sglang/Triton/etc.
		// inference server still benefits — KV-cache reuse is a property of the
		// server, not the provider id.
		const loopback = llamaCppQwenModel({ provider: "custom", baseUrl: "http://localhost:9000/v1" }).compat;
		const rfc1918 = llamaCppQwenModel({ provider: "custom", baseUrl: "http://10.0.0.42:8080/v1" }).compat;
		const mdns = llamaCppQwenModel({ provider: "custom", baseUrl: "http://workstation.local:8080/v1" }).compat;
		expect(loopback.replayReasoningContent).toBe(true);
		expect(rfc1918.replayReasoningContent).toBe(true);
		expect(mdns.replayReasoningContent).toBe(true);
	});

	it("leaves replayReasoningContent off for LiteLLM (local proxy, not a chat-template renderer)", () => {
		// LiteLLM defaults to http://localhost:4000/v1 but forwards every turn
		// to an unrelated upstream (OpenAI, Anthropic, …). Replaying
		// reasoning_content gains no KV-cache benefit and can 400 the upstream
		// on extra message fields, so the auto-detection MUST exclude proxy
		// providers from both the provider allow-list and the loopback
		// heuristic. Users running a custom proxy who do want the replay can
		// opt in via `compat.replayReasoningContent: true`.
		const defaults = llamaCppQwenModel({ provider: "litellm", baseUrl: "http://localhost:4000/v1" }).compat;
		const customLoopback = llamaCppQwenModel({ provider: "litellm", baseUrl: "http://127.0.0.1:9000/v1" }).compat;
		expect(defaults.replayReasoningContent).toBe(false);
		expect(customLoopback.replayReasoningContent).toBe(false);
	});

	it("honors an explicit replayReasoningContent override on a proxy provider", () => {
		// Escape hatch for a user who knows their LiteLLM deployment fronts a
		// llama.cpp-style backend that benefits from the replay.
		const optedIn = llamaCppQwenModel({
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			compat: { replayReasoningContent: true },
		}).compat;
		expect(optedIn.replayReasoningContent).toBe(true);
	});

	it("leaves replayReasoningContent off for non-reasoning local models", () => {
		// The flag only matters when thinking blocks could exist on prior turns.
		const compat = llamaCppQwenModel({ reasoning: false }).compat;
		expect(compat.replayReasoningContent).toBe(false);
	});

	it("leaves replayReasoningContent off for cloud OpenAI-compatible providers", () => {
		// A regression that flipped this on for every reasoning provider would
		// pessimize wire payloads on hosts that don't reconstruct `<think>` from
		// `reasoning_content` and could even 400 on strict ones.
		const openai = buildModel({
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} satisfies ModelSpec<"openai-completions">).compat;
		expect(openai.replayReasoningContent).toBe(false);
	});

	it("replays reasoning_content on plain-text assistant turns for llama.cpp (no tool calls)", () => {
		// The reporter's request 12 had finish_reason=stop, no tool calls, just
		// text. The auto-learn nudge then arrived as the next user turn. Existing
		// `requires*ReasoningContent*` recovery paths gate on tool calls, so this
		// pin guards the new branch specifically: thinking blocks on a pure-text
		// assistant turn must still ride as `reasoning_content` for llama.cpp.
		const target = llamaCppQwenModel();
		const messages: Message[] = [
			userMessage("Review the unpushed commit."),
			assistantWithReasoning(
				"Let me review the unpushed changes comprehensively.",
				"## Review: 1 unpushed commit + 1 unstaged change",
			),
			userMessage("Before you finish: if this turn produced anything reusable, capture it now."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.content).toBe("## Review: 1 unpushed commit + 1 unstaged change");
		expect(assistant.reasoning_content).toBe("Let me review the unpushed changes comprehensively.");
	});

	it("honors the streamed signature when it identifies a recognized wire field", () => {
		// Some llama.cpp builds stream reasoning under `reasoning` rather than
		// `reasoning_content`. Round-trip into the same field so the chat
		// template sees the exact key the server emitted.
		const target = llamaCppQwenModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content: [
				{ type: "thinking", thinking: "trace A", thinkingSignature: "reasoning" } satisfies ThinkingContent,
				{ type: "text", text: "answer A" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning).toBe("trace A");
		expect(found?.reasoning_content).toBeUndefined();
	});

	it("falls back to reasoningContentField for opaque thinking signatures", () => {
		// Anthropic/OpenAI-Responses thinking blocks ride a binary continuation
		// signature that is meaningless as a chat-completions field name. Use
		// the configured `reasoningContentField` (default `reasoning_content`)
		// rather than synthesizing a key from the opaque signature.
		const target = llamaCppQwenModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content: [
				{
					type: "thinking",
					thinking: "trace B",
					thinkingSignature: "rs_0123456789abcdef",
				} satisfies ThinkingContent,
				{ type: "text", text: "answer B" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning_content).toBe("trace B");
		expect("rs_0123456789abcdef" in (found ?? {})).toBe(false);
	});

	it("does NOT replay reasoning_content when the target has no reasoning blocks", () => {
		// Pure-text turn with no thinking content stays minimal — the
		// replay branch only fires when there is actually something to preserve.
		const target = llamaCppQwenModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "llama.cpp",
			model: "qwen-3.6-27b",
			content: [{ type: "text", text: "plain answer" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.content).toBe("plain answer");
		expect(found?.reasoning_content).toBeUndefined();
		expect(found?.reasoning).toBeUndefined();
	});
});
