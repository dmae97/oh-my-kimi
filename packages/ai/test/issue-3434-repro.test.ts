/**
 * Regression guard for cross-API 3p ↔ 3p thinking-block preservation (#3434).
 *
 * Mid-session switches between an Anthropic-compatible 3p provider and an
 * OpenAI-compatible 3p provider on the same vendor (Z.AI Anthropic → Z.AI
 * OpenAI, Kimi Anthropic → Kimi OpenAI, …) used to demote every prior
 * `thinking` block to plain text on the cross-API path of `transformMessages`:
 *
 *     // Cross-API target: keep the existing text-demotion fallback.
 *     return { type: "text", text: sanitized.thinking };
 *
 * The next request shipped the reasoning chain as conversation text instead
 * of structured `reasoning_content`, so the target model lost the prior
 * reasoning context and the user paid twice — once to generate the thinking
 * on the source endpoint, once again to re-derive it on the target.
 *
 * The fix has two halves:
 *
 *  1. `transformMessages` preserves the prior thinking text as a native,
 *     signature-stripped `thinking` block whenever the target encoder can
 *     re-emit it on the wire (today: `openai-completions` reasoning targets
 *     that accept `reasoning_content` as a continuation hint).
 *  2. The `openai-completions` encoder surfaces those preserved blocks via
 *     `reasoningContentField` even for hosts that don't strictly require
 *     `reasoning_content` — specifically `thinkingFormat: "zai"` targets.
 *
 * This file pins the wire output for the canonical scenarios.
 */
import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
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

const ZAI_OPAQUE_SIGNATURE = "Ev0CCkYIBhgCKkArbase64sigfromzai==";

function zaiAnthropicMessage(thinkingText: string): AssistantMessage {
	// Z.AI's Anthropic-format 3p endpoint (api.z.ai/api/anthropic). The source
	// signature looks like an Anthropic continuation hint but is opaque to any
	// other API — the cross-API path MUST strip it before the encoder reads it.
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "zai",
		model: "glm-5.2",
		content: [
			{ type: "thinking", thinking: thinkingText, thinkingSignature: ZAI_OPAQUE_SIGNATURE },
			{ type: "text", text: "Done." },
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

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function zaiOpenAITarget(): Model<"openai-completions"> {
	// Z.AI's OpenAI-format endpoint (api.z.ai/api/coding/paas/v4 — same vendor
	// catalog entry as the Anthropic source above). thinkingFormat resolves to
	// "zai"; requiresReasoningContentForToolCalls is false.
	return buildModel({
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		compat: {
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
	} satisfies ModelSpec<"openai-completions">);
}

function deepseekReasoningTarget(): Model<"openai-completions"> {
	// DeepSeek-family reasoning target: requiresReasoningContentForToolCalls is
	// true here, so the preserved block reaches reasoning_content via the
	// existing recovery branch. Guards the other half of the fix from regressing.
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"openai-completions">);
}

function opencodeGoKimiTarget(): Model<"openai-completions"> {
	// OpenCode Go's reasoning-enabled Kimi. Base compat keeps
	// `requiresReasoningContentForToolCalls: false` to dodge the
	// `Extra inputs are not permitted` 400 (#1071); only the resolved
	// `whenThinking` policy reactivates it (#1484). `convertMessages` threads
	// that request-time resolved compat into `transformMessages`, so a
	// thinking-on request preserves the prior reasoning; without the resolved
	// compat the predicate would read base compat, demote to text, and the
	// next thinking-on request would 400 with `thinking is enabled but
	// reasoning_content is missing in assistant tool call message at index N`.
	return buildModel({
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 16_384,
	} satisfies ModelSpec<"openai-completions">);
}

function openAIGpt4oTarget(): Model<"openai-completions"> {
	// Official OpenAI Chat Completions, non-reasoning. Thinking blocks must
	// still demote to text — this target can't usefully emit `reasoning_content`.
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} satisfies ModelSpec<"openai-completions">);
}

describe("cross-API thinking-block preservation (#3433/#3434)", () => {
	it("emits reasoning_content on Z.AI Anthropic → Z.AI OpenAI cross-API switch", () => {
		const target = zaiOpenAITarget();
		const messages: Message[] = [
			userMessage("Build a plan"),
			zaiAnthropicMessage("Step 1 explore. Step 2 patch. Step 3 verify."),
			userMessage("Continue the same plan on the other endpoint."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		// The reasoning chain rides as structured `reasoning_content` on the
		// next request, not folded into the visible `content` text.
		expect(assistant.reasoning_content).toBe("Step 1 explore. Step 2 patch. Step 3 verify.");
		expect(assistant.content).toBe("Done.");
	});

	it("strips the source signature on the preserved cross-API thinking block", () => {
		// The Z.AI Anthropic signature is bound to the Anthropic wire-format and
		// useless to the OpenAI target. The preserved block surfaces only the
		// reasoning text; no opaque signature may leak onto the wire as a stray
		// field name.
		const target = zaiOpenAITarget();
		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("opaque continuation metadata payload"),
			userMessage("Continue."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(ZAI_OPAQUE_SIGNATURE in assistant).toBe(false);
		expect(assistant.reasoning_content).toBe("opaque continuation metadata payload");
	});

	it("emits reasoning_content on Anthropic 3p → DeepSeek cross-API switch", () => {
		// DeepSeek-family reasoning targets reach reasoning_content via the
		// existing `requiresReasoningContentForToolCalls` recovery branch. This
		// pin guards against a regression in either fix half that would drop
		// the preserved block before recovery runs.
		const target = deepseekReasoningTarget();
		const messages: Message[] = [
			userMessage("Inspect README"),
			zaiAnthropicMessage("Read README and answer."),
			userMessage("Continue on DeepSeek."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBe("Read README and answer.");
	});

	it("demotes thinking to text when the target cannot replay reasoning_content", () => {
		// Anthropic 3p → official OpenAI non-reasoning model: the encoder
		// cannot emit `reasoning_content` here (the field would be ignored and
		// strict OpenAI-compat shims would reject it). Reasoning must survive
		// at minimum as visible conversation text so the next turn still sees
		// the prior plan.
		const target = openAIGpt4oTarget();
		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("Explore the repo, then patch it."),
			userMessage("Continue."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBeUndefined();
		const content = assistant.content;
		expect(typeof content).toBe("string");
		if (typeof content !== "string") throw new Error("content not a string");
		expect(content).toContain("Explore the repo, then patch it.");
		expect(content).toContain("Done.");
	});

	it("preserves cross-API thinking for OpenCode reasoning targets that gate replay via compat.whenThinking", () => {
		// OpenCode (`opencode-go`, `opencode-zen`) reasoning models keep
		// `requiresReasoningContentForToolCalls: false` on the base compat
		// (dodges the thinking-off `Extra inputs are not permitted` 400 — #1071)
		// and reactivate the flag on `compat.whenThinking` for thinking-engaged
		// requests (dodges the `thinking is enabled but reasoning_content is
		// missing` 400 — #1484). The cross-API preservation predicate must run
		// against the resolved compat that `convertMessages` threads in (the
		// `whenThinking` view here); reading base compat would demote the prior
		// thinking to text and re-trigger #1484 on the next thinking-on request.
		const target = opencodeGoKimiTarget();
		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("Read README and answer."),
			userMessage("Continue on OpenCode."),
		];

		// Resolve the thinking-engaged compat the way `streamOpenAICompletions`
		// does for a request with reasoning effort set, then hand it to
		// `convertMessages` directly so the test exercises the same encoder
		// configuration the live wire would.
		const compat = target.compat.whenThinking ?? target.compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);

		const wire = convertMessages(target, { messages }, compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBe("Read README and answer.");
	});

	it("demotes prior thinking to content when the OpenCode base compat (thinking off) cannot surface reasoning_content", () => {
		// Companion of the prior test: same OpenCode target, but the request
		// runs against the BASE compat (thinking disabled, the path that bars
		// `reasoning_content` per #1071). The cross-API preservation predicate
		// reads this resolved base compat — which neither requires
		// `reasoning_content` nor is a Z.AI-format host — so it preserves no
		// native thinking block the encoder couldn't surface; the cross-API path
		// instead text-demotes the prior reasoning into visible content. The
		// reasoning still survives as conversation context, with no
		// `reasoning_content` on the wire and no #1071 regression.
		const target = opencodeGoKimiTarget();
		const compat = target.compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);

		const messages: Message[] = [
			userMessage("Plan it."),
			zaiAnthropicMessage("Read README and answer."),
			userMessage("Continue with thinking off."),
		];

		const wire = convertMessages(target, { messages }, compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.reasoning_content).toBeUndefined();
		const content = assistant.content;
		expect(typeof content).toBe("string");
		if (typeof content !== "string") throw new Error("content not a string");
		expect(content).toContain("Read README and answer.");
		expect(content).toContain("Done.");
	});

	it("does not promote markup-healed same-model thinking into visible content", () => {
		// Markup-healed streams (MiniMax `<think>…</think>`, Kimi K2 healed
		// reasoning, …) record thinking blocks with `thinkingSignature: undefined`
		// because the healer reconstructs them from raw text deltas. On a
		// same-model continuation those blocks are PRIVATE reasoning the source
		// emitted, not cross-API preserved reasoning. Same-model history is never
		// signature-stripped or text-demoted by `transformMessages`, and no
		// encoder branch consumes an unsigned same-model thinking block, so it
		// falls through unemitted — the hidden chain-of-thought must never leak
		// into the next request's visible `content`.
		const target = opencodeGoKimiTarget();
		const compat = target.compat;
		const sameModelAssistant: AssistantMessage = {
			role: "assistant",
			api: target.api,
			provider: target.provider,
			model: target.id,
			content: [
				{ type: "thinking", thinking: "hidden chain-of-thought, must not leak" },
				{ type: "text", text: "Visible answer." },
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
		const messages: Message[] = [userMessage("Plan it."), sameModelAssistant, userMessage("Continue.")];

		const wire = convertMessages(target, { messages }, compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		// Visible content stays exactly what the model produced on the last turn.
		expect(assistant.content).toBe("Visible answer.");
		// And the private reasoning is not promoted anywhere on the wire.
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.reasoning).toBeUndefined();
		expect(assistant.reasoning_text).toBeUndefined();
	});
});
