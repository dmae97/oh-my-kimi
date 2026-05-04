import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import {
	normalizeOpenAIResponsesPromptCacheKey,
	type OpenAIResponsesOptions,
	streamOpenAIResponses,
} from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;
const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function getHeader(headers: RequestInit["headers"], name: string): string | null {
	return new Headers(headers).get(name);
}

async function captureOpenAIResponseHeaders(
	options: OpenAIResponsesOptions,
): Promise<{ sessionId: string | null; clientRequestId: string | null; body: Record<string, unknown> | null }> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		body: null as Record<string, unknown> | null,
	};
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		return createSseResponse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

	const context: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamOpenAIResponses(model, context, { apiKey: "test-key", ...options });

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("openai-responses cache affinity", () => {
	it("sets session routing headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI session routing headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("omits OpenAI session routing headers when cache retention is disabled", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.prompt_cache_key).toBeUndefined();
	});

	it("normalizes long prompt cache keys while preserving ordered system prompts", async () => {
		const longSessionId = "session-".repeat(20);
		const expectedCacheKey = normalizeOpenAIResponsesPromptCacheKey(longSessionId);
		if (!expectedCacheKey) throw new Error("Expected normalized prompt cache key");
		const captured = await captureOpenAIResponseHeaders({ sessionId: longSessionId });

		expect(captured.sessionId).toBe(expectedCacheKey);
		expect(captured.clientRequestId).toBe(expectedCacheKey);
		expect(captured.body?.prompt_cache_key).toBe(expectedCacheKey);
		expect(expectedCacheKey?.length).toBeLessThanOrEqual(64);

		const input = captured.body?.input;
		expect(Array.isArray(input)).toBe(true);
		expect((input as Array<{ role?: string; content?: string }>).slice(0, 2)).toEqual([
			{ role: "developer", content: "stable system" },
			{ role: "developer", content: "stable durable context" },
		]);
	});
});
