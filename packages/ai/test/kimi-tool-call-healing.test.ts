import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model, ToolCall } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

interface SseChoiceDelta {
	content?: string;
}

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: SseChoiceDelta;
		finish_reason?: "stop" | "tool_calls" | "length" | null;
	}>;
}

function sseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mockFetch(events: ReadonlyArray<SseChunk | "[DONE]">): typeof fetch {
	const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "list the files", timestamp: Date.now() }],
	};
}

function kimiModel(): Model<"openai-completions"> {
	// OpenRouter-hosted Kimi K2 — the model-id gate engages without pulling
	// in the kimi-code OAuth/device-id paths.
	return getBundledModel("openrouter", "moonshotai/kimi-k2");
}

function chunk(model: string, delta: SseChoiceDelta, finish: SseChunk["choices"][0]["finish_reason"] = null): SseChunk {
	return {
		id: "chatcmpl-kimi-test",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

describe("Kimi K2 leaked tool-call healing", () => {
	const model = kimiModel();

	it("strips a complete section emitted in a single chunk and synthesizes the tool call", async () => {
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>" +
			'{"path":"src/index.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		global.fetch = mockFetch([
			chunk(model.id, { content: "I'll read it. " }),
			chunk(model.id, { content: leaked }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test" }).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).toBe("I'll read it. ");
		expect(text).not.toContain("<|");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "src/index.ts" });
		expect(toolCalls[0].id).toMatch(/^call_[0-9a-f]+$/);

		// Section was emitted alongside finish_reason:"stop" — promote to toolUse.
		expect(result.stopReason).toBe("toolUse");
	});

	it("reconstructs a section split across chunk boundaries (token straddles two chunks)", async () => {
		const full =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>list_files:0<|tool_call_argument_begin|>" +
			'{"path":"."}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		// Split mid-token to force partial-prefix holdback.
		const split = "<|tool_ca";
		const a = full.slice(0, full.indexOf(split) + split.length);
		const b = full.slice(a.length);
		expect(a + b).toBe(full);
		expect(a.endsWith("<|tool_ca")).toBe(true);

		global.fetch = mockFetch([
			chunk(model.id, { content: a }),
			chunk(model.id, { content: b }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test" }).result();

		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");
		expect(text).toBe("");

		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("list_files");
		expect(toolCalls[0].arguments).toEqual({ path: "." });
		expect(result.stopReason).toBe("toolUse");
	});

	it("handles multiple tool calls inside a single section", async () => {
		const leaked =
			"<|tool_calls_section_begin|>" +
			"<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>" +
			'{"path":"a.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_call_begin|>functions.read:1<|tool_call_argument_begin|>" +
			'{"path":"b.ts"}' +
			"<|tool_call_end|>" +
			"<|tool_calls_section_end|>";

		global.fetch = mockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test" }).result();
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");

		expect(toolCalls).toHaveLength(2);
		expect(toolCalls.map(tc => tc.name)).toEqual(["read", "read"]);
		expect(toolCalls.map(tc => tc.arguments)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
		// IDs are independently generated, never colliding.
		expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
	});

	it("preserves arguments split across many chunks (no premature parse)", async () => {
		const head = "<|tool_calls_section_begin|><|tool_call_begin|>functions.write:0<|tool_call_argument_begin|>";
		const tail = "<|tool_call_end|><|tool_calls_section_end|>";
		const argsParts = ['{"path":"', "out.txt", '","content":"', "hello world", '"}'];

		global.fetch = mockFetch([
			chunk(model.id, { content: head }),
			...argsParts.map(part => chunk(model.id, { content: part })),
			chunk(model.id, { content: tail }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test" }).result();
		const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");

		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("write");
		expect(toolCalls[0].arguments).toEqual({ path: "out.txt", content: "hello world" });
	});

	it("passes prose through unchanged when no markers are present", async () => {
		global.fetch = mockFetch([
			chunk(model.id, { content: "Hello, " }),
			chunk(model.id, { content: "world!" }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");

		expect(text).toBe("Hello, world!");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
		expect(result.stopReason).toBe("stop");
	});

	it("emits a literal '<|' that is not a token prefix without holding it back forever", async () => {
		// `<|hello|>` is not any known token. It should land in visible text.
		global.fetch = mockFetch([
			chunk(model.id, { content: "before <|hello|> after" }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test" }).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("");

		expect(text).toBe("before <|hello|> after");
		expect(result.content.some(b => b.type === "toolCall")).toBe(false);
	});
});
