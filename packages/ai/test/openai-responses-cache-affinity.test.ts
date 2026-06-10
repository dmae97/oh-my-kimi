import { afterEach, describe, expect, it, vi } from "bun:test";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

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
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
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

	const context: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamOpenAIResponses(model, context, { apiKey: "test-key", ...options, fetch: fetchMock });

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses cache affinity", () => {
	it("sets session routing headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});
	it("keeps prompt cache key separate from OpenAI routing headers when both are provided", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "side-channel-456",
			promptCacheKey: "session-123",
		});

		expect(captured.sessionId).toBe("side-channel-456");
		expect(captured.clientRequestId).toBe("side-channel-456");
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

	it("merges adapter extra body fields into the Responses request payload", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			extraBody: {
				prompt_cache_key: "adapter-cache-key",
				x_provider_hint: "xai",
			},
		});

		expect(captured.body?.prompt_cache_key).toBe("adapter-cache-key");
		expect(captured.body?.x_provider_hint).toBe("xai");
	});

	it("omits OpenAI session routing headers when cache retention is disabled", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.prompt_cache_key).toBeUndefined();
	});
});
