import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): typeof fetch {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "run a command", timestamp: Date.now() }],
		tools: [
			{
				name: "bash",
				description: "Run a shell command",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				},
			},
		],
	};
}

function toolCallChunk(model: Model<"openai-completions">, fn: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: [{ index: 0, id: "call-minimax-1", type: "function", function: fn }],
				},
			},
		],
	};
}

function stopChunk(model: Model<"openai-completions">): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
}

describe("issue #1776 - MiniMax object-shaped tool arguments", () => {
	it("preserves object-shaped streamed tool arguments without a serialization round-trip", async () => {
		const model = getBundledModel<"openai-completions">("minimax-code-cn", "MiniMax-M3");
		global.fetch = createMockFetch([
			toolCallChunk(model, { name: "bash", arguments: { command: "printf '%s\\n' ok" } }),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call-minimax-1", name: "bash", arguments: { command: "printf '%s\\n' ok" } },
		]);
	});

	it("still assembles tool arguments streamed as the standard JSON-string deltas", async () => {
		const model = getBundledModel<"openai-completions">("minimax-code-cn", "MiniMax-M3");
		global.fetch = createMockFetch([
			toolCallChunk(model, { name: "bash", arguments: '{"command":' }),
			toolCallChunk(model, { arguments: ' "printf ok"}' }),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call-minimax-1", name: "bash", arguments: { command: "printf ok" } },
		]);
	});
});
