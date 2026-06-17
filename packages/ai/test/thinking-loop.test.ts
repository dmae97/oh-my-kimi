import { describe, expect, test } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockContent, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	isGeminiThinkingLoopModel,
	THINKING_LOOP_ERROR_MARKER,
	ThinkingLoopDetector,
	withGeminiThinkingLoopGuard,
} from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { isRetryableError } from "@oh-my-pi/pi-utils";

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "go", timestamp: 0 }] };
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

/** A degenerate near-duplicate reasoning loop: the same paragraph intent with
 *  cosmetic wording drift, blank-line separated (the gemini-3.5-flash shape). */
function nearDuplicateLoop(paragraphs: number): string {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const out: string[] = [];
	for (let i = 0; i < paragraphs; i++) {
		out.push(`**Confirming Safety ${i}**\n\n${variants[i % variants.length]}`);
	}
	return out.join("\n\n\n");
}

/** Genuinely distinct reasoning paragraphs — must never trip the detector. */
function distinctReasoning(): string {
	return [
		"First I read the agent loop to understand how the stream wrapper commits the final assistant message.",
		"Next I traced the retry classifier to see which error shapes are treated as transient by the session.",
		"The Vertex transport needs ADC, so its credential path differs from the OpenRouter completions route entirely.",
		"I should add a regression covering the empty-content terminal so the auto-retry gate stays satisfied later.",
		"The tokenizer counts code points, which matters for the wide-emoji case in the truncation helper above here.",
		"Compaction journals are per-request, so they never persist into the on-disk session transcript at all ever.",
		"The mock provider emits one delta per block, so streaming nuances need a direct detector unit test instead.",
		"Finally I will run the focused package suite and the type checker before touching the changelog entries now.",
		"Telemetry spans wrap each provider call, so failing one must still close its span in the catch branch too.",
		"A device default of CPU keeps the tiny model worker from crashing Bun on teardown across every platform now.",
	].join("\n\n\n");
}

describe("isGeminiThinkingLoopModel", () => {
	test("matches direct and aggregator-routed gemini ids, not lookalikes", () => {
		const gate = (provider: string, id: string) => isGeminiThinkingLoopModel(createMockModel({ provider, id }).model);
		expect(gate("google", "gemini-3-pro-preview")).toBe(true);
		expect(gate("openrouter", "google/gemini-3.5-flash")).toBe(true);
		expect(gate("google-gemini-cli", "gemini-3-flash")).toBe(true);
		expect(gate("openai", "gpt-5.5")).toBe(false);
		expect(gate("google", "gemma-3-1b")).toBe(false);
	});

	test("trusts the compat flag over the id regex for every OpenAI-compat API", () => {
		const gate = (api: string, id: string, enableGeminiThinkingLoopGuard: boolean) =>
			isGeminiThinkingLoopModel({
				api,
				provider: "openrouter",
				id,
				compat: { enableGeminiThinkingLoopGuard },
			} as unknown as Model<Api>);
		// Opaque proxy alias opted in despite a non-gemini id (completions + responses).
		expect(gate("openai-completions", "my-fast-model", true)).toBe(true);
		expect(gate("openai-responses", "my-fast-model", true)).toBe(true);
		// Gemini-shaped id explicitly opted out stays off — the flag wins over the regex.
		expect(gate("openai-completions", "gemini-3.5-flash", false)).toBe(false);
		expect(gate("openai-responses", "gemini-3.5-flash", false)).toBe(false);
	});

	test("guards non-compat Gemini transports (Vertex, direct Google) via id", () => {
		const gate = (api: string, provider: string, id: string) =>
			isGeminiThinkingLoopModel({ api, provider, id } as unknown as Model<Api>);
		// Vertex has no OpenAICompat record; its canonical ids are gemini-shaped.
		expect(gate("google-vertex", "google-vertex", "gemini-2.5-pro")).toBe(true);
		expect(gate("google-generative-ai", "google", "gemini-3-pro")).toBe(true);
		// Non-Gemini models on the same transports (e.g. Claude on Vertex) stay unguarded.
		expect(gate("google-vertex", "google-vertex", "claude-sonnet-4")).toBe(false);
	});
});

describe("ThinkingLoopDetector", () => {
	test("trips on near-duplicate segments fed as small streamed chunks", () => {
		const detector = new ThinkingLoopDetector();
		const text = nearDuplicateLoop(12);
		let detail: string | null = null;
		for (let i = 0; i < text.length && !detail; i += 17) {
			detail = detector.push(text.slice(i, i + 17));
		}
		expect(detail).toContain("near-identical segments");
	});

	test("trips on verbatim back-to-back repetition", () => {
		const detector = new ThinkingLoopDetector();
		const detail = detector.push("🌊 ".repeat(120));
		expect(detail).toContain("back-to-back");
	});

	test("does not trip on genuinely distinct reasoning paragraphs", () => {
		const detector = new ThinkingLoopDetector();
		let detail: string | null = null;
		const text = distinctReasoning();
		for (let i = 0; i < text.length && !detail; i += 23) {
			detail = detector.push(text.slice(i, i + 23));
		}
		// flush the trailing paragraph too
		detail ??= detector.flush();
		expect(detail).toBeNull();
	});

	test("flush() catches a final unterminated duplicate paragraph", () => {
		const detector = new ThinkingLoopDetector();
		// Seven blank-line-separated dupes leave the eighth (cluster-completing)
		// paragraph in the buffer with no trailing blank line.
		const block = `${nearDuplicateLoop(7)}\n\n\nI am now verifying the test module to guarantee there are no compile errors and the code is completely safe.`;
		expect(detector.push(block)).toBeNull();
		expect(detector.flush()).toContain("near-identical segments");
	});

	test("does not trip on legitimate repetitive numeric output", () => {
		// A zero-page hexdump is highly repetitive but legitimate: a unit with no
		// letter or pictograph must never count as a loop.
		const detector = new ThinkingLoopDetector();
		expect(detector.push("00 ".repeat(200))).toBeNull();
	});

	test("does not trip on short requested repetitive text", () => {
		// Below the repeated-char floor: a brief on-purpose repeat is not a loop.
		const detector = new ThinkingLoopDetector();
		expect(detector.push("🌊 ".repeat(26))).toBeNull();
	});
});

describe("gemini thinking-loop guard (stream wrapper)", () => {
	function loopingThinkingResponse(): { content: MockContent[] } {
		return { content: [{ type: "thinking", thinking: nearDuplicateLoop(12) }] };
	}

	test("terminates a gemini loop with a retryable empty-content error", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push(loopingThinkingResponse());

			const result = await stream(mock.model, context()).result();

			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
			// Empty content + transient phrasing is what makes the turn auto-retry.
			expect(result.errorMessage).toContain("stream stall");
			expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("emits no observable thinking/text content before the error terminal", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push(loopingThinkingResponse());

			const events = await collect(stream(mock.model, context()));
			const terminal = events.at(-1);
			expect(terminal?.type).toBe("error");
			// The guard must not forward the looping thinking_end / done.
			expect(events.some(e => e.type === "thinking_end")).toBe(false);
			expect(events.some(e => e.type === "done")).toBe(false);
		} finally {
			clearCustomApis();
		}
	});

	test("passes a non-gemini model through untouched even when it loops", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openai", id: "gpt-5.5" });
			mock.push(loopingThinkingResponse());

			const result = await stream(mock.model, context()).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content.some(b => b.type === "thinking")).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("does not trip on a healthy gemini turn that reasons then answers", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push({ content: [{ type: "thinking", thinking: distinctReasoning() }, "Here is the final answer."] });

			const result = await stream(mock.model, context()).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content.some(b => b.type === "text")).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("does not retry once a loop re-emerges after visible answer text (armed latch)", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			// Healthy reasoning, then visible answer text, then a runaway loop re-emitted
			// as cumulative reasoning after `</think>` (the openai-completions shape).
			mock.push({
				content: [
					{ type: "thinking", thinking: distinctReasoning() },
					"Here is the final answer.",
					{ type: "thinking", thinking: nearDuplicateLoop(12) },
				],
			});

			const result = await stream(mock.model, context()).result();

			// Visible text already streamed, so the loop must NOT hijack the turn.
			expect(result.stopReason).toBe("stop");
			expect(result.content.some(b => b.type === "text")).toBe(true);
		} finally {
			clearCustomApis();
		}
	});

	test("guards the streamSimple custom-api path (agent default entrypoint)", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
			mock.push(loopingThinkingResponse());

			const result = await streamSimple(mock.model, context()).result();

			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
			expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
		} finally {
			clearCustomApis();
		}
	});
});

describe("withGeminiThinkingLoopGuard (Vertex transport)", () => {
	test("emits a retryable empty-content error for a looping Vertex Gemini stream", async () => {
		const model = { api: "google-vertex", provider: "google-vertex", id: "gemini-2.5-pro" } as unknown as Model<Api>;
		const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

		const guarded = withGeminiThinkingLoopGuard(model, undefined, () => {
			const inner = new AssistantMessageEventStream();
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial },
				{ type: "thinking_start", contentIndex: 0, partial },
				{ type: "thinking_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial },
				{ type: "thinking_end", contentIndex: 0, content: "", partial },
				{ type: "done", reason: "stop", message: partial },
			];
			for (const event of events) inner.push(event);
			return inner;
		});

		const result = await guarded.result();
		expect(result.stopReason).toBe("error");
		expect(result.content.length).toBe(0);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		expect(isRetryableError(new Error(result.errorMessage))).toBe(true);
	});
});
