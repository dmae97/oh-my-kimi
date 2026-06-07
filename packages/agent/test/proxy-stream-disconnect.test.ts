/**
 * Tests for proxy stream behavior when the server disconnects
 * without sending a terminal event (done/error).
 *
 * Contract: `streamProxy` MUST emit an error event and resolve
 * `stream.result()` when the SSE stream ends without a terminal
 * event — it must NOT silently complete with default stopReason='stop'.
 */
import { describe, expect, it } from "bun:test";
import { streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import type { ProxyAssistantMessageEvent } from "@oh-my-pi/pi-agent-core/proxy";
import type { AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai";

const mockModel: Model = {
	id: "test-model",
	name: "Test Model",
	api: "openai",
	provider: "test",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

function buildSseBody(events: ProxyAssistantMessageEvent[]): ReadableStream<Uint8Array> {
	const parts: string[] = [];
	for (const event of events) {
		parts.push(`data: ${JSON.stringify(event)}\n\n`);
	}
	const text = parts.join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

async function withMockFetch<R>(
	body: ReadableStream<Uint8Array>,
	status: number,
	fn: () => Promise<R>,
): Promise<R> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
		new Response(body, { status });
	try {
		return await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function collectEvents(
	stream: ReturnType<typeof streamProxy>,
	timeoutMs = 2000,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const iterator = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const result = await Promise.race([
			iterator.next(),
			new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
				setTimeout(() => resolve({ value: undefined, done: true } as IteratorResult<AssistantMessageEvent>), timeoutMs),
			),
		]);
		if (result.done) break;
		events.push(result.value);
	}
	return events;
}

const baseUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("streamProxy — server disconnect without terminal event", () => {
	it("emits an error event when server disconnects after start with no terminal event", async () => {
		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);

		const collected = await withMockFetch(body, 200, async () => {
			const stream = streamProxy(mockModel, { role: "user", content: "hello", timestamp: Date.now() } as never, {
				proxyUrl: "http://localhost:0",
				authToken: "test",
			});
			return collectEvents(stream);
		});

		const hasError = collected.some((e) => e.type === "error");
		expect(hasError).toBe(true);
	});

	it("resolves stream.result() with stopReason='error' when server disconnects mid-stream", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hel" },
		];
		const body = buildSseBody(events);

		await withMockFetch(body, 200, async () => {
			const stream = streamProxy(mockModel, { role: "user", content: "hello", timestamp: Date.now() } as never, {
				proxyUrl: "http://localhost:0",
				authToken: "test",
			});

			// Consume iterator so the internal async function runs
			const collected = await collectEvents(stream);
			expect(collected.some((e) => e.type === "error")).toBe(true);

			// stream.result() MUST resolve (not hang) with an error message
			const result = await Promise.race([
				stream.result().then((r) => ({ resolved: true as const, value: r })),
				new Promise<{ resolved: false }>((resolve) =>
					setTimeout(() => resolve({ resolved: false }), 500),
				),
			]);

			expect(result.resolved).toBe(true);
			if (result.resolved) {
				expect(result.value.stopReason).toBe("error");
				expect(result.value.errorMessage).toBeTruthy();
			}
		});
	});

	it("completes normally when server sends a 'done' event", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello" },
			{ type: "text_end", contentIndex: 0 },
			{
				type: "done",
				reason: "stop",
				usage: { ...baseUsage },
			},
		];
		const body = buildSseBody(events);

		await withMockFetch(body, 200, async () => {
			const stream = streamProxy(mockModel, { role: "user", content: "hello", timestamp: Date.now() } as never, {
				proxyUrl: "http://localhost:0",
				authToken: "test",
			});

			const collected = await collectEvents(stream);
			expect(collected.some((e) => e.type === "done")).toBe(true);

			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(result.content.length).toBeGreaterThan(0);
		});
	});
});