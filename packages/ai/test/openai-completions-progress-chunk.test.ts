import { describe, expect, it } from "bun:test";
import { isOpenAICompletionsProgressChunk } from "../src/providers/openai-completions";

/**
 * Contract: `isOpenAICompletionsProgressChunk` decides whether a streamed chunk
 * resets the idle-watchdog deadline in `iterateWithIdleTimeout`. A false
 * positive (counting a no-op chunk as progress) silently disables the
 * watchdog and is the root cause of the z.ai/GLM-via-OpenRouter hang where
 * a subagent stalled for hours with no error surfaced. A false negative is
 * cheap (delays the watchdog by at most the first-event window).
 */
describe("isOpenAICompletionsProgressChunk", () => {
	describe("non-progress chunks (MUST NOT reset the watchdog)", () => {
		it("rejects null/non-object", () => {
			expect(isOpenAICompletionsProgressChunk(null)).toBe(false);
			expect(isOpenAICompletionsProgressChunk(undefined)).toBe(false);
			expect(isOpenAICompletionsProgressChunk("hi")).toBe(false);
			expect(isOpenAICompletionsProgressChunk(42)).toBe(false);
		});

		it("rejects empty {} keepalives", () => {
			expect(isOpenAICompletionsProgressChunk({})).toBe(false);
		});

		it("rejects {choices: []} keepalives", () => {
			expect(isOpenAICompletionsProgressChunk({ choices: [] })).toBe(false);
		});

		it("rejects role-only preambles", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { role: "assistant" } }],
				}),
			).toBe(false);
		});

		it("rejects empty-string content deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: "" } }],
				}),
			).toBe(false);
		});

		it("rejects empty-array content deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: [] } }],
				}),
			).toBe(false);
		});

		it("rejects empty tool_calls arrays", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { tool_calls: [] } }],
				}),
			).toBe(false);
		});

		it("rejects empty reasoning fields", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning: "" } }],
				}),
			).toBe(false);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_content: "" } }],
				}),
			).toBe(false);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_text: "" } }],
				}),
			).toBe(false);
		});
	});

	describe("progress chunks (MUST reset the watchdog)", () => {
		it("accepts a top-level usage chunk (terminal token report)", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					usage: { prompt_tokens: 12, completion_tokens: 4 },
				}),
			).toBe(true);
		});

		it("accepts choice-level usage", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ usage: { prompt_tokens: 12 } }],
				}),
			).toBe(true);
		});

		it("accepts finish_reason", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ finish_reason: "stop" }],
				}),
			).toBe(true);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ finish_reason: "tool_calls" }],
				}),
			).toBe(true);
		});

		it("accepts text content deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: "Hello" } }],
				}),
			).toBe(true);
		});

		it("accepts array-shape content parts (Mistral-style)", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: [{ type: "text", text: "Hi" }] } }],
				}),
			).toBe(true);
		});

		it("accepts tool call deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [
						{
							delta: {
								tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
							},
						},
					],
				}),
			).toBe(true);
		});

		it("accepts reasoning deltas in all three field names", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning: "thinking..." } }],
				}),
			).toBe(true);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_content: "thinking..." } }],
				}),
			).toBe(true);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_text: "thinking..." } }],
				}),
			).toBe(true);
		});

		it("accepts refusal deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { refusal: "I can't help with that." } }],
				}),
			).toBe(true);
		});
	});
});
