import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	getOpenAICodexTransportDetails,
	getOpenAICodexWebSocketDebugStats,
	prewarmOpenAICodexResponses,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model, ModelSpec, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const originalCodexWebSocketRetryBudget = Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET;
const originalCodexWebSocketRetryDelayMs = Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS;
const originalCodexWebSocketV2 = Bun.env.PI_CODEX_WEBSOCKET_V2;
const originalCodexWebSocketIdleTimeoutMs = Bun.env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
const originalCodexWebSocketFirstEventTimeoutMs = Bun.env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS;
const originalCodexWebSocketPingIntervalMs = Bun.env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS;
const originalCodexWebSocketPongTimeoutMs = Bun.env.PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS;
const originalCodexWebSocketMessageQueueCapacity = Bun.env.PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY;
const originalCodexWebSocketMaxIdleReuseMs = Bun.env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	restoreEnv("PI_CODEX_WEBSOCKET_RETRY_BUDGET", originalCodexWebSocketRetryBudget);
	restoreEnv("PI_CODEX_WEBSOCKET_RETRY_DELAY_MS", originalCodexWebSocketRetryDelayMs);
	restoreEnv("PI_CODEX_WEBSOCKET_V2", originalCodexWebSocketV2);
	restoreEnv("PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS", originalCodexWebSocketIdleTimeoutMs);
	restoreEnv("PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS", originalCodexWebSocketFirstEventTimeoutMs);
	restoreEnv("PI_CODEX_WEBSOCKET_PING_INTERVAL_MS", originalCodexWebSocketPingIntervalMs);
	restoreEnv("PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS", originalCodexWebSocketPongTimeoutMs);
	restoreEnv("PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY", originalCodexWebSocketMessageQueueCapacity);
	restoreEnv("PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS", originalCodexWebSocketMaxIdleReuseMs);
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(baseUrl?: string): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: baseUrl ?? "",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

function createStatefulCodexSse(text: string, responseId: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}`,
		`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] } })}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) return init.signal;
	if (input instanceof Request) return input.signal;
	return undefined;
}

function createNoProgressCodexSse(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_stalled",
						call_id: "call_stalled",
						name: "todo",
						arguments: "",
					},
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						type: "response.in_progress",
						response: { id: "resp_stalled", status: "in_progress" },
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function encodeWebSocketMessage(value: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

type WsHeaders = Record<string, string>;
type WsEventType = "open" | "message" | "error" | "close";

const DEFAULT_USAGE = {
	input_tokens: 5,
	output_tokens: 3,
	total_tokens: 8,
	input_tokens_details: { cached_tokens: 0 },
};

/**
 * Drop-in mock for the global `WebSocket` used by the codex websocket transport.
 *
 * Production code wires lifecycle handlers via `onopen`/`onmessage`/`onerror`/`onclose`
 * properties; tests drive the connection by calling `emit()`, `scheduleOpen()`,
 * `sendJson()`, or the `emitCodexResponse()` convenience.
 */
class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";

	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: { headers?: WsHeaders },
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	/** Dispatch an event to the matching `on{type}` handler. */
	emit(type: WsEventType, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	/** Asynchronously transition to OPEN and emit `open`. */
	scheduleOpen(): void {
		setTimeout(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	/** Emit a message frame with arbitrary data. */
	sendMessage(data: unknown): void {
		this.emit("message", { data } as unknown as MessageEvent);
	}

	/** Emit a message frame with stringified-JSON data. */
	sendJson(payload: Record<string, unknown>): void {
		this.sendMessage(JSON.stringify(payload));
	}

	/** Emit the standard Codex completed-response sequence. */
	emitCodexResponse(opts: {
		messageId: string;
		responseId: string;
		text: string;
		terminalType?: "response.done" | "response.completed";
		includeCreated?: boolean;
	}): void {
		const { messageId, responseId, text, terminalType = "response.done", includeCreated = false } = opts;
		if (includeCreated) {
			this.sendJson({ type: "response.created", response: { id: responseId } });
		}
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({
			type: terminalType,
			response: {
				id: responseId,
				status: "completed",
				usage: DEFAULT_USAGE,
			},
		});
	}
}

describe("openai-codex streaming", () => {
	it("normalizes Codex response endpoint base URLs", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const requestedUrls: string[] = [];
		const sse = createCompletedCodexSse("Hello");
		const fetchMock = vi.fn(async (input: string | URL) => {
			requestedUrls.push(typeof input === "string" ? input : input.toString());
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		for (const baseUrl of [
			undefined,
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
		]) {
			const model = { ...createCodexTestModel(baseUrl), preferWebsockets: false };
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey: token,
				fetch: fetchMock as FetchImpl,
			}).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(requestedUrls).toEqual([
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
		]);
	});

	it("maps end_turn=false on the terminal event to a pause_turn stop", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const completedResponse = {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		};
		const commentaryItem = {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			phase: "commentary",
			content: [{ type: "output_text", text: "Scanning the repo first." }],
		};
		const toolCallItem = {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read_file",
			arguments: '{"path":"README.md"}',
		};
		const sseFor = (item: Record<string, unknown>, endTurn: boolean): string =>
			`${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }), status: "in_progress" } })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { ...completedResponse, end_turn: endTurn } })}`,
			].join("\n\n")}\n\n`;
		const streamWith = (sse: string) =>
			streamOpenAICodexResponses(model, createCodexTestContext(), {
				apiKey: token,
				fetch: (async () =>
					new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl,
			}).result();

		// Commentary-only response with an unfinished turn -> non-terminal stop.
		const paused = await streamWith(sseFor(commentaryItem, false));
		expect(paused.stopReason).toBe("stop");
		expect(paused.stopDetails).toEqual({ type: "pause_turn" });

		// Finished turn -> plain stop, no pause marker.
		const finished = await streamWith(sseFor(commentaryItem, true));
		expect(finished.stopReason).toBe("stop");
		expect(finished.stopDetails).toBeUndefined();

		// With tool calls the agent loop continues through execution; the pause
		// marker must not double-trigger continuation.
		const toolUse = await streamWith(sseFor(toolCallItem, false));
		expect(toolUse.stopReason).toBe("toolUse");
		expect(toolUse.stopDetails).toBeUndefined();
	});

	it("persists final tool-call args when SSE finalizes via output_item.done without an args.done event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		// Two small arg deltas: the second grows the buffer far less than the
		// throttle's min-growth threshold, so the throttled parser skips the final
		// re-parse. No function_call_arguments.done is sent, leaving
		// output_item.done as the sole finalization path; it must still persist the
		// full arguments on the stored block rather than the stale partial parse.
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } })}`,
			`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"' })}`,
			`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'README.md"}' })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();

		const toolCall = result.content.find(c => c.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected a finalized toolCall block");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		expect("partialJson" in toolCall).toBe(false);
		expect("lastParseLen" in toolCall).toBe(false);
	});

	it("waits for caller abort when SSE streams only no-progress status events", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const fetchMock: FetchImpl = (input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressCodexSse(getRequestSignal(input, init)));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);

		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			signal: controller.signal,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toBe("OpenAI Codex SSE stream stalled while waiting for the next event");
		expect(result.content as unknown[]).toEqual([
			{
				type: "toolCall",
				id: "call_stalled|fc_stalled",
				name: "todo",
				arguments: {},
				partialJson: "",
			},
		]);
	});

	it("parses websocket JSON from non-string payloads", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		class BinaryPayloadWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				const added = encodeWebSocketMessage({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				});
				const contentPart = encodeWebSocketMessage({
					type: "response.content_part.added",
					part: { type: "output_text", text: "" },
				});
				const delta = encodeWebSocketMessage({ type: "response.output_text.delta", delta: "Hello binary" });
				const done = encodeWebSocketMessage({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello binary" }],
					},
				});
				const completed = encodeWebSocketMessage({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
				// Exercise every payload shape the production decoder must accept.
				this.sendMessage(added.buffer.slice(added.byteOffset, added.byteOffset + added.byteLength));
				this.sendMessage(contentPart);
				this.sendMessage(Buffer.from(delta));
				this.sendMessage(Buffer.from(done));
				this.sendMessage(completed.buffer.slice(completed.byteOffset, completed.byteOffset + completed.byteLength));
			}
		}

		global.WebSocket = BinaryPayloadWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-binary-payload-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello binary");
		expect(result.stopReason).toBe("stop");
	});

	it("forwards websocket frames through onSseEvent for the raw-SSE debug viewer", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();

		class ObservedWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_obs", responseId: "resp_obs", text: "Observed" });
			}
		}
		global.WebSocket = ObservedWebSocket as unknown as typeof WebSocket;

		const observed: Array<{ event: string | null; data: string; raw: string[] }> = [];
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-observer-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				onSseEvent: event => {
					observed.push({ event: event.event, data: event.data, raw: [...event.raw] });
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");

		// First record is the outbound request frame (the JSON we sent).
		const [outbound, ...inbound] = observed;
		expect(outbound).toBeDefined();
		expect(outbound.raw[0]).toMatch(/^: ws → /);
		expect(outbound.data.length).toBeGreaterThan(0);
		expect(() => JSON.parse(outbound.data)).not.toThrow();

		// Inbound frames mirror the Codex response sequence emitted by `emitCodexResponse`.
		expect(inbound.map(e => e.event)).toEqual([
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_item.done",
			"response.done",
		]);
		for (const event of inbound) {
			expect(event.raw[0]).toBe(`: ws ← ${event.event}`);
			// Synthesized SSE wire shape: `event:` line then `data:` line.
			expect(event.raw[1]).toBe(`event: ${event.event}`);
			expect(event.raw[2]).toBe(`data: ${event.data}`);
			expect(JSON.parse(event.data)).toMatchObject({ type: event.event });
		}
	});

	it("sends websocket protocol pings while the connection is open", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS = "1";
		const token = createCodexTestToken();
		let pingCount = 0;

		class HeartbeatWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			ping(): void {
				pingCount += 1;
			}

			send(): void {
				setTimeout(() => {
					this.emitCodexResponse({ messageId: "msg_ping", responseId: "resp_ping", text: "Pinged" });
				}, 10);
			}
		}
		global.WebSocket = HeartbeatWebSocket as unknown as typeof WebSocket;

		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-heartbeat-session",
				providerSessionState,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(pingCount).toBeGreaterThan(0);
		for (const state of providerSessionState.values()) {
			state.close();
		}
	});

	it("falls back to SSE when the websocket inbound queue overflows", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = "1";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";
		const token = createCodexTestToken();
		const sse = createCompletedCodexSse("Recovered over SSE");
		const fetchMock = vi.fn(async () => {
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		class QueueOverflowWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({ type: "response.created", response: { id: "resp_overflow" } });
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_overflow", role: "assistant", status: "in_progress", content: [] },
				});
			}
		}
		global.WebSocket = QueueOverflowWebSocket as unknown as typeof WebSocket;

		const providerSessionState = new Map<string, ProviderSessionState>();
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-queue-overflow-session",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.role).toBe("assistant");
		expect(fetchMock).toHaveBeenCalled();
		const details = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-queue-overflow-session",
			providerSessionState,
		});
		expect(details.lastTransport).toBe("sse");
		expect(details.websocketDisabled).toBe(true);
		expect(details.fallbackCount).toBe(1);
	});

	it("omits request-body headers and replaces stale beta headers for websocket handshakes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let capturedHeaders: Record<string, string> | undefined;
		class HeaderCaptureWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({
					type: "response.done",
					response: {
						id: "resp_ws",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				});
			}
		}

		global.WebSocket = HeaderCaptureWebSocket as unknown as typeof WebSocket;
		await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"OpenAI-Beta": "responses=experimental",
					"openai-beta": "responses=stale",
				},
				sessionId: "ws-header-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(capturedHeaders?.accept).toBeUndefined();
		expect(capturedHeaders?.["content-type"]).toBeUndefined();
		expect(capturedHeaders?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
		expect(Object.keys(capturedHeaders ?? {}).filter(key => key.toLowerCase() === "openai-beta")).toHaveLength(1);
	});

	it("sends the Responses Lite marker on the upgrade and in response.create client_metadata", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let capturedHeaders: WsHeaders | undefined;
		const sentRequests: Array<Record<string, unknown>> = [];
		class LiteWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.emitCodexResponse({ messageId: "msg_lite", responseId: "resp_lite", text: "Hi" });
			}
		}

		global.WebSocket = LiteWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-lite-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				responsesLite: true,
				clientMetadata: { "x-codex-turn-metadata": '{"thread_id":"t_1"}' },
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedHeaders?.["x-openai-internal-codex-responses-lite"]).toBe("true");
		expect(sentRequests).toHaveLength(1);
		expect(sentRequests[0]?.type).toBe("response.create");
		expect(sentRequests[0]?.client_metadata).toEqual({
			"x-codex-turn-metadata": '{"thread_id":"t_1"}',
			ws_request_header_x_openai_internal_codex_responses_lite: "true",
		});
	});

	it("streams SSE responses into AssistantMessageEventStream", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
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
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("pi");
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock as FetchImpl });
		let sawTextDelta = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				expect(event.message.content.find(c => c.type === "text")?.text).toBe("Hello");
			}
		}

		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
	});

	it("includes service_tier in SSE payloads when requested", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		let capturedBody: Record<string, unknown> | undefined;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "default", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			serviceTier: "priority",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.service_tier).toBe("priority");
		expect(result.usage.cost.input).toBeCloseTo(0.00001);
		expect(result.usage.cost.output).toBeCloseTo(0.000012);
		expect(result.usage.cost.total).toBeCloseTo(0.000022);
	});

	it("fails truncated SSE streams that never emit a terminal response event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("terminal completion event");
	});

	it("stops reading SSE responses after a terminal response event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			`data: ${JSON.stringify({ type: "response.failed", code: "server_error", message: "late failure after terminal event" })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello");
	});

	it("surfaces 429 errors after retry budget checks without body reuse failures", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(
					JSON.stringify({
						error: {
							code: "rate_limit_exceeded",
							message: "too many requests",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "600",
						},
					},
				);
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("rate limit");
		expect(result.errorMessage).not.toContain("Body already used");
	});

	it("retries transient model_error SSE events before surfacing an error", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		let requestCount = 0;

		const successSse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_retry", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello after retry" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_retry", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello after retry" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const errorSse = `${[
			`data: ${JSON.stringify({
				type: "error",
				code: "model_error",
				message: "An error occurred while processing your request. You can retry your request.",
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				requestCount += 1;
				return new Response(requestCount === 1 ? errorSse : successSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello after retry");
	});

	it("sets conversation_id/session_id headers and prompt_cache_key when sessionId is provided", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
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
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const sessionId = "test-session-123";
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify sessionId is set in headers
				expect(headers?.get("conversation_id")).toBe(sessionId);
				expect(headers?.get("session_id")).toBe(sessionId);
				expect(headers?.get("x-client-request-id")).toBe(sessionId);

				// Verify sessionId is set in request body as prompt_cache_key
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.prompt_cache_key).toBe(sessionId);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId,
			fetch: fetchMock as FetchImpl,
		});
		await streamResult.result();
	});
	it("keeps prompt_cache_key separate from Codex conversation headers", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const token = createCodexTestToken();
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const sessionId = "side-channel-session";
		const promptCacheKey = "main-session-cache";
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
				capturedBody =
					typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
				return new Response(createCompletedCodexSse("Hello"), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId,
			promptCacheKey,
		}).result();

		expect(capturedHeaders?.get("conversation_id")).toBe(sessionId);
		expect(capturedHeaders?.get("session_id")).toBe(sessionId);
		expect(capturedHeaders?.get("x-client-request-id")).toBe(sessionId);
		expect(capturedBody?.prompt_cache_key).toBe(promptCacheKey);
	});

	it("rejects gpt-5.3-codex minimal reasoning effort instead of clamping", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
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
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.reasoning).toEqual({ effort: "low", summary: "auto" });

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model = buildModel({
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			reasoning: "minimal",
		});
		const response = await streamResult.result();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("Supported efforts: low, medium, high, xhigh");
	});

	it("does not set conversation_id/session_id headers when sessionId is not provided", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
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
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify headers are not set when sessionId is not provided
				expect(headers?.has("conversation_id")).toBe(false);
				expect(headers?.has("session_id")).toBe(false);

				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		// No sessionId provided
		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock as FetchImpl });
		await streamResult.result();
	});

	it("falls back to SSE when websocket connect fails", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		class FailingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				setTimeout(() => {
					expect(this.options?.headers?.["OpenAI-Beta"] ?? this.options?.headers?.["openai-beta"]).toStartWith(
						"responses_websockets=",
					);
					this.emit("error", new Event("error"));
					this.emit("close", new Event("close"));
					this.readyState = MockWebSocket.CLOSED;
				}, 0);
			}
		}

		global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const streamResult = streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-session",
			providerSessionState,
		});
		const result = await streamResult.result();
		expect(result.role).toBe("assistant");
		expect(fetchMock).toHaveBeenCalled();
		const fallbackDetails = getOpenAICodexTransportDetails(model, { sessionId: "ws-session", providerSessionState });
		expect(fallbackDetails.lastTransport).toBe("sse");
		expect(fallbackDetails.websocketDisabled).toBe(true);
		expect(fallbackDetails.fallbackCount).toBe(1);
	});

	it("immediately falls back to SSE on fatal websocket connection errors", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { id: "resp_sse", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async () => {
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});

		let constructorCount = 0;
		class FailingConnectWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				setTimeout(() => {
					this.emit("error", new Event("error"));
					this.emit("close", new Event("close"));
					this.readyState = MockWebSocket.CLOSED;
				}, 0);
			}
		}

		global.WebSocket = FailingConnectWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
		}).result();
		expect(result.role).toBe("assistant");
		expect(constructorCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
		expect(transportDetails.fallbackCount).toBe(1);
	});

	it("captures websocket handshake metadata and replays it on later SSE requests", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			expect(headers.get("x-codex-turn-state")).toBe("ws-turn-state-1");
			expect(headers.get("x-models-etag")).toBe("models-etag-1");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		class HandshakeWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "models-etag-1",
				"x-reasoning-included": "true",
			};

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_ws", responseId: "resp_ws", text: "Hello WS" });
			}
		}

		global.WebSocket = HandshakeWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const sseModel: Model<"openai-codex-responses"> = buildModel({
			...websocketModel,
			preferWebsockets: false,
			compat: websocketModel.compatConfig,
		} as ModelSpec<"openai-codex-responses">);
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const first = await streamOpenAICodexResponses(websocketModel, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		// Turn-state is scoped to the current turn, so the SSE replay must be a
		// within-turn continuation (trailing tool result) to carry the header.
		const followUp: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...context.messages,
				{
					...first,
					stopReason: "toolUse" as const,
					content: [
						...first.content,
						{ type: "toolCall" as const, id: "call_meta|fc_meta", name: "todo", arguments: {} },
					],
				},
				{
					role: "toolResult" as const,
					toolCallId: "call_meta|fc_meta",
					toolName: "todo",
					content: [{ type: "text" as const, text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		await streamOpenAICodexResponses(sseModel, followUp, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("includes service_tier in websocket payloads when requested", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sentRequests: Array<Record<string, unknown>> = [];

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class ServiceTierWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Hello WS" });
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello WS" }],
					},
				});
				this.sendJson({ type: "response.created", response: { id: "resp_ws" } });
				this.sendJson({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
			}
		}

		global.WebSocket = ServiceTierWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			serviceTier: "priority",
			sessionId: "ws-service-tier-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests[0]?.type).toBe("response.create");
		expect(sentRequests[0]?.service_tier).toBe("priority");
		expect(result.usage.premiumRequests).toBeUndefined();
	});

	it("sends websocket continuation deltas after prior assistant response items and records stats", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class DeltaWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: responseIndex === 1 ? "First answer" : "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = DeltaWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant.", "Use concise answers."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant.", "Use concise answers."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() },
			],
		};
		await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[0]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[0]?.instructions).toBe("You are a helpful assistant.");
		const initialInput = sentRequests[0]?.input;
		expect(Array.isArray(initialInput)).toBe(true);
		const initialItems = initialInput as Array<{ role?: string; content?: unknown }>;
		expect(initialItems).toHaveLength(2);
		expect(initialItems[0]?.role).toBe("developer");
		expect(JSON.stringify(initialItems[0]?.content)).toContain("Use concise answers.");
		expect(initialItems[1]?.role).toBe("user");
		expect(sentRequests[1]?.type).toBe("response.create");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[1]?.instructions).toBe("You are a helpful assistant.");
		const deltaInput = sentRequests[1]?.input;
		expect(Array.isArray(deltaInput)).toBe(true);
		const deltaItems = deltaInput as Array<{ role?: string }>;
		expect(deltaItems).toHaveLength(1);
		expect(deltaItems[0]?.role).toBe("user");
		expect(JSON.stringify(deltaItems)).toContain("Second question");
		expect(JSON.stringify(deltaItems)).not.toContain("First answer");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-delta-session",
			providerSessionState,
		});
		expect(stats).toEqual({
			fullContextRequests: 1,
			deltaRequests: 1,
			lastInputItems: 1,
			lastDeltaInputItems: 1,
			lastPreviousResponseId: "resp_1",
		});
	});

	it("retries websocket continuations with full context when previous_response_id expires", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class PreviousResponseMissingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						code: "previous_response_not_found",
						message: "Previous response with id 'resp_1' not found.",
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = PreviousResponseMissingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.prompt_cache_key).toBe("ws-expired-previous-response-session");
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		});
		expect(stats).toEqual({
			fullContextRequests: 2,
			deltaRequests: 1,
			lastInputItems: (retryInput as unknown[]).length,
			lastDeltaInputItems: undefined,
			lastPreviousResponseId: undefined,
		});
	});

	it("uses low Codex text verbosity by default while preserving explicit overrides", async () => {
		const tempDir = TempDir.createSync("@pi-codex-verbosity-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const capturedBodies: Array<Record<string, unknown>> = [];
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_verbosity", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_verbosity", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock as FetchImpl }).result();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			textVerbosity: "high",
			fetch: fetchMock as FetchImpl,
		}).result();

		expect((capturedBodies[0]?.text as { verbosity?: string } | undefined)?.verbosity).toBe("low");
		expect((capturedBodies[1]?.text as { verbosity?: string } | undefined)?.verbosity).toBe("high");
	});

	it("uses websocket v2 beta header when v2 mode is enabled", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_V2 = "1";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class WebSocketV2HeaderProbe extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				expect(options?.headers?.["OpenAI-Beta"] ?? options?.headers?.["openai-beta"]).toBe(
					"responses_websockets=2026-02-06",
				);
				this.scheduleOpen();
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_v2", responseId: "resp_v2", text: "Hello v2" });
			}
		}

		global.WebSocket = WebSocketV2HeaderProbe as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-v2-session",
			providerSessionState,
		}).result();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("waits for caller abort when a prewarmed websocket is silent before its first event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			return new Response(createCompletedCodexSse("unexpected fallback"), {
				headers: { "content-type": "text/event-stream" },
			});
		});

		let sendCount = 0;
		class IdleWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
			}
		}

		global.WebSocket = IdleWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
			signal: controller.signal,
		}).result();
		expect(sendCount).toBeGreaterThanOrEqual(1);
		expect(result.stopReason).toBe("aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces a websocket idle-timeout error when status events never make semantic progress", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run once the websocket stream becomes replay-unsafe");
		});

		let sendCount = 0;
		let interval: NodeJS.Timeout | undefined;
		class NoProgressWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_ws_stalled",
						call_id: "call_ws_stalled",
						name: "todo",
						arguments: "",
					},
				});
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_ws_stalled",
						call_id: "call_ws_stalled",
						name: "todo",
						arguments: "{}",
					},
				});
				interval = setInterval(() => {
					this.sendJson({
						type: "response.in_progress",
						response: { id: "resp_ws_stalled", status: "in_progress" },
					});
				}, 2);
			}

			close(): void {
				if (interval) clearInterval(interval);
				super.close();
			}
		}
		global.WebSocket = NoProgressWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-no-progress-session",
			providerSessionState,
			streamIdleTimeoutMs: 5,
		}).result();

		expect(sendCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("idle timeout waiting for websocket");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "call_ws_stalled|fc_ws_stalled",
				name: "todo",
				arguments: {},
			}),
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries, then surfaces an error, when whitespace-only tool-call argument deltas never recover", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for degenerate tool-call arguments");
		});

		let sendCount = 0;
		let closeCount = 0;
		class WhitespaceArgumentsWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_ws_whitespace",
						call_id: "call_ws_whitespace",
						name: "todo",
						arguments: "",
					},
				});
				for (let sequence = 1; sequence <= 300; sequence += 1) {
					this.sendJson({
						type: "response.function_call_arguments.delta",
						delta: sequence % 2 === 0 ? " ".repeat(64) : "\t",
						item_id: "fc_ws_whitespace",
						output_index: 1,
						sequence_number: sequence,
					});
				}
			}

			close(): void {
				closeCount += 1;
				super.close();
			}
		}
		global.WebSocket = WhitespaceArgumentsWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-whitespace-arguments-session",
			providerSessionState,
		}).result();

		// One initial attempt + CODEX_WHITESPACE_LOOP_RETRY_LIMIT (2) bounded retries.
		expect(sendCount).toBe(3);
		expect(closeCount).toBeGreaterThan(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
		expect(result.errorMessage).toContain("fc_ws_whitespace");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("drops the degenerate tool call and recovers when a retried websocket stream completes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run when the websocket recovers");
		});

		let connectionCount = 0;
		let closeCount = 0;
		class RecoveringWhitespaceWebSocket extends MockWebSocket {
			#index: number;
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.#index = connectionCount;
				connectionCount += 1;
				this.scheduleOpen();
			}

			send(): void {
				if (this.#index === 0) {
					// First attempt: a function call whose arguments are only whitespace.
					// A completed reasoning item lands in nativeOutputItems before the
					// degenerate tool call begins; it must not survive the retry.
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "reasoning", id: "rs_stale", summary: [] },
					});
					this.sendJson({
						type: "response.output_item.done",
						item: { type: "reasoning", id: "rs_stale", summary: [{ type: "summary_text", text: "stale" }] },
					});
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "todo", arguments: "" },
					});
					for (let sequence = 1; sequence <= 300; sequence += 1) {
						this.sendJson({
							type: "response.function_call_arguments.delta",
							delta: sequence % 2 === 0 ? " ".repeat(64) : "\t",
							item_id: "fc_ws",
							output_index: 0,
							sequence_number: sequence,
						});
					}
					return;
				}
				// Retried attempt: the model emits a well-formed tool call and completes.
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "todo", arguments: "" },
				});
				this.sendJson({
					type: "response.function_call_arguments.delta",
					delta: '{"ops":[{"op":"start","task":"x"}]}',
					item_id: "fc_ws",
					output_index: 0,
					sequence_number: 1,
				});
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_ws",
						call_id: "call_ws",
						name: "todo",
						arguments: '{"ops":[{"op":"start","task":"x"}]}',
					},
				});
				this.sendJson({
					type: "response.completed",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
			}

			close(): void {
				closeCount += 1;
				super.close();
			}
		}
		global.WebSocket = RecoveringWhitespaceWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-whitespace-recovery-session",
			providerSessionState,
		}).result();

		expect(connectionCount).toBe(2);
		expect(closeCount).toBeGreaterThan(0);
		expect(result.stopReason).not.toBe("error");
		expect(result.errorMessage).toBeUndefined();
		const toolCall = result.content.find(block => block.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected a recovered toolCall block");
		expect(toolCall.name).toBe("todo");
		expect(toolCall.id).toBe("call_ws|fc_ws");
		expect(toolCall.arguments).toEqual({ ops: [{ op: "start", task: "x" }] });
		// Native items from the abandoned first attempt must not leak into the
		// replayed turn's history payload (stale reasoning would be re-sent as
		// input on the next request).
		const payload = result.providerPayload as { items?: Array<{ id?: string }> } | undefined;
		const payloadIds = (payload?.items ?? []).map(item => item.id);
		expect(payloadIds).toContain("fc_ws");
		expect(payloadIds).not.toContain("rs_stale");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("interrupts whitespace-only custom tool input deltas", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for degenerate custom tool input");
		});

		let sendCount = 0;
		class WhitespaceCustomInputWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "custom_tool_call", id: "ctc_ws", call_id: "call_ctc_ws", name: "apply_patch", input: "" },
				});
				for (let sequence = 1; sequence <= 300; sequence += 1) {
					this.sendJson({
						type: "response.custom_tool_call_input.delta",
						delta: sequence % 2 === 0 ? " ".repeat(64) : "\t",
						item_id: "ctc_ws",
						output_index: 0,
						sequence_number: sequence,
					});
				}
			}
		}
		global.WebSocket = WhitespaceCustomInputWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-whitespace-custom-input-session",
			providerSessionState,
		}).result();

		// One initial attempt + CODEX_WHITESPACE_LOOP_RETRY_LIMIT (2) bounded retries.
		expect(sendCount).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
		expect(result.errorMessage).toContain("ctc_ws");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("delivers a queued terminal event when the server closes immediately after it", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run when the response completed");
		});

		let constructorCount = 0;
		class EagerCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(): void {
				// Every frame lands in the connection queue synchronously, before the
				// consumer microtask drains any of them; the close event used to wipe
				// the queued terminal event and turn success into a transport error.
				this.emitCodexResponse({ messageId: "msg_eager", responseId: "resp_eager", text: "Hello eager" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1000 } as unknown as Event);
			}
		}
		global.WebSocket = EagerCloseWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-eager-close-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello eager" })]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces a connection-limit error instead of replaying a delivered tool call over SSE", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE replay must not run after a toolcall_end was delivered");
		});

		let constructorCount = 0;
		class ConnectionLimitWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_limit", call_id: "call_limit", name: "todo", arguments: "" },
				});
				this.sendJson({
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_limit", call_id: "call_limit", name: "todo", arguments: "{}" },
				});
				this.sendJson({
					type: "error",
					code: "websocket_connection_limit_reached",
					message: "connection limit reached",
				});
			}
		}
		global.WebSocket = ConnectionLimitWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-connection-limit-toolcall-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("connection limit reached");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("joins an in-flight websocket handshake instead of tearing it down", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run when the handshake is joined");
		});

		let constructorCount = 0;
		const sockets: DeferredOpenWebSocket[] = [];
		class DeferredOpenWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				sockets.push(this);
			}

			open(): void {
				this.readyState = MockWebSocket.OPEN;
				this.emit("open", new Event("open"));
			}

			close(): void {
				const wasPending = this.readyState === MockWebSocket.CONNECTING;
				super.close();
				if (wasPending) this.emit("close", { code: 1000 } as unknown as Event);
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_join", responseId: "resp_join", text: "Joined" });
			}
		}
		global.WebSocket = DeferredOpenWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		// Prewarm starts the handshake; the stream call races it before the socket
		// opens. Tearing down the CONNECTING socket would reject the prewarm with a
		// fatal "websocket closed before open" and disable websockets for the session.
		const prewarmPromise = prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-join-session",
			providerSessionState,
		});
		const streamResult = streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-join-session",
			providerSessionState,
		}).result();

		// Let both callers reach the handshake before the socket opens.
		await Bun.sleep(5);
		for (const socket of sockets) socket.open();

		await prewarmPromise;
		const result = await streamResult;

		expect(constructorCount).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Joined" })]);
		const details = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-join-session",
			providerSessionState,
		});
		expect(details.websocketDisabled).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("bounds connection-limit reconnects and replays over SSE when the budget is exhausted", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "2";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";
		const token = createCodexTestToken();

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Recovered" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_sse",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Recovered" }],
				},
			})}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_sse", status: "completed" } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		let constructorCount = 0;
		class AlwaysLimitedWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({
					type: "error",
					code: "websocket_connection_limit_reached",
					message: "connection limit reached",
				});
			}
		}
		global.WebSocket = AlwaysLimitedWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-connection-limit-bounded-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		// 1 initial connection + PI_CODEX_WEBSOCKET_RETRY_BUDGET bounded reconnects,
		// then a single SSE replay — never an unbounded reconnect loop.
		expect(constructorCount).toBe(3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Recovered" })]);
	});

	it("surfaces a whitespace flood arriving after a delivered tool call instead of replaying", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE replay must not run after a toolcall_end was delivered");
		});

		let sendCount = 0;
		class PostDoneWhitespaceWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_flood", call_id: "call_flood", name: "todo", arguments: "" },
				});
				this.sendJson({
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_flood", call_id: "call_flood", name: "todo", arguments: "{}" },
				});
				// Degenerate frames keep arriving after the item closed. They count as
				// progress events, so without the breaker observing them the idle
				// watchdog never fires and the turn hangs forever.
				for (let sequence = 1; sequence <= 300; sequence += 1) {
					this.sendJson({
						type: "response.function_call_arguments.delta",
						delta: " ".repeat(64),
						item_id: "fc_flood",
						output_index: 0,
						sequence_number: sequence,
					});
				}
			}
		}
		global.WebSocket = PostDoneWhitespaceWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-post-done-whitespace-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		// A toolcall_end already reached the consumer: replay is refused and the
		// breaker error surfaces on the first attempt.
		expect(sendCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
		// The completed tool call is preserved on the error message.
		expect(result.content).toEqual([expect.objectContaining({ type: "toolCall", name: "todo" })]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries websocket stream closes before surfacing transport errors", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "1";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called when websocket retry succeeds");
		});

		let constructorCount = 0;
		const requestTypes: string[] = [];

		class FlakyCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				if (requestTypes.length === 1) {
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1012 } as unknown as Event);
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_retry_close",
					responseId: "resp_retry_close",
					text: "Hello retry close",
				});
			}
		}

		global.WebSocket = FlakyCloseWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-retry-close-session",
			providerSessionState,
		}).result();

		expect(result.role).toBe("assistant");
		expect(constructorCount).toBe(2);
		expect(requestTypes).toEqual(["response.create", "response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to SSE when websocket becomes unavailable before stream start", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello fallback" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_ws_unavailable", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello fallback" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		class UnavailableBeforeStreamWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1006 } as unknown as Event);
				}, 0);
			}
		}

		global.WebSocket = UnavailableBeforeStreamWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-unavailable-session",
			providerSessionState,
		}).result();

		expect(result.role).toBe("assistant");
		expect(result.stopReason).not.toBe("error");
		expect(result.errorMessage).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-unavailable-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
		expect(transportDetails.fallbackCount).toBe(1);
	});

	it("resets websocket append state after an aborted request closes the connection", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		const sentTypesByConnection: string[][] = [];
		let constructorCount = 0;
		let abortSecondRequest: (() => void) | undefined;

		class AbortResetWebSocket extends MockWebSocket {
			#connectionIndex: number;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.#connectionIndex = constructorCount;
				constructorCount += 1;
				sentTypesByConnection[this.#connectionIndex] = [];
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypesByConnection[this.#connectionIndex]?.push(requestType);
				const requestIndex = sentTypesByConnection[this.#connectionIndex]?.length ?? 0;

				if (this.#connectionIndex === 0 && requestIndex === 1) {
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello one" });
					return;
				}
				if (this.#connectionIndex === 0 && requestIndex === 2) {
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Still streaming" });
					setTimeout(() => {
						abortSecondRequest?.();
					}, 0);
					return;
				}
				if (this.#connectionIndex === 1 && requestIndex === 1) {
					expect(requestType).toBe("response.create");
					this.emitCodexResponse({ messageId: "msg_3", responseId: "resp_3", text: "Hello three" });
					return;
				}
				throw new Error(`Unexpected websocket send sequence: ${this.#connectionIndex}:${requestIndex}`);
			}
		}

		global.WebSocket = AbortResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			providerSessionState,
		}).result();
		expect(firstResult.role).toBe("assistant");

		const secondAbortController = new AbortController();
		abortSecondRequest = () => {
			secondAbortController.abort();
		};
		const secondResult = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			signal: secondAbortController.signal,
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("aborted");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			providerSessionState,
		}).result();
		expect(thirdResult.role).toBe("assistant");
		expect(constructorCount).toBe(2);
		expect(sentTypesByConnection[0]).toEqual(["response.create", "response.create"]);
		expect(sentTypesByConnection[1]).toEqual(["response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("resets websocket append state after websocket error events", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		const sentTypes: string[] = [];
		let constructorCount = 0;

		class ErrorResetWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypes.push(requestType);
				const requestIndex = sentTypes.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello one" });
					return;
				}
				if (requestIndex === 2) {
					this.sendJson({
						type: "error",
						code: "invalid_request_error",
						message: "simulated request error",
					});
					return;
				}
				if (requestIndex === 3) {
					expect(requestType).toBe("response.create");
					this.emitCodexResponse({ messageId: "msg_3", responseId: "resp_3", text: "Hello three" });
					return;
				}
				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = ErrorResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(firstResult.role).toBe("assistant");

		const secondResult = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("error");
		expect(secondResult.errorMessage).toContain("simulated request error");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(thirdResult.role).toBe("assistant");
		expect(constructorCount).toBe(1);
		expect(sentTypes).toEqual(["response.create", "response.create", "response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to SSE when websocket receives malformed JSON before completion", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Recovered over SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Recovered over SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		class MalformedMessageWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.sendMessage("{");
			}
		}

		global.WebSocket = MalformedMessageWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-malformed-json-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(c => c.type === "text")?.text).toBe("Recovered over SSE");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("replays over SSE when websocket closes after buffered output without a terminal event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse_replay", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Replay succeeded" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse_replay", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Replay succeeded" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		class BufferedCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "message",
						id: "msg_ws_partial",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Partial output" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1006 } as unknown as Event);
			}
		}

		global.WebSocket = BufferedCloseWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-buffered-close-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(c => c.type === "text")?.text).toBe("Replay succeeded");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resets append state and stale turn headers when websocket requests diverge", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sseTurnStates: Array<string | null> = [];
		const sseModelsEtags: Array<string | null> = [];
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			sseTurnStates.push(headers.get("x-codex-turn-state"));
			sseModelsEtags.push(headers.get("x-models-etag"));
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const requestTypes: string[] = [];
		class DivergedAppendWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "ws-models-etag-1",
			};
			#sendCount = 0;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				this.#sendCount += 1;
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				const idSuffix = String(this.#sendCount);
				this.emitCodexResponse({
					messageId: `msg_${idSuffix}`,
					responseId: `resp_${idSuffix}`,
					text: `Hello WS ${idSuffix}`,
				});
			}
		}

		global.WebSocket = DivergedAppendWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const sseModel: Model<"openai-codex-responses"> = buildModel({
			...websocketModel,
			preferWebsockets: false,
			compat: websocketModel.compatConfig,
		} as ModelSpec<"openai-codex-responses">);
		const firstContext: Context = {
			systemPrompt: ["Prompt A"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["Prompt B"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		await streamOpenAICodexResponses(websocketModel, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(websocketModel, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(sseModel, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();

		expect(requestTypes).toEqual(["response.create", "response.create"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sseTurnStates[0]).toBeNull();
		expect(sseModelsEtags[0]).toBeNull();
	});

	it("reuses a prewarmed websocket connection across turns", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		let constructorCount = 0;
		let sendCount = 0;
		class ReusableWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(data: string): void {
				sendCount += 1;
				const request = JSON.parse(data) as Record<string, unknown>;
				expect(typeof request.type).toBe("string");
				this.emitCodexResponse({
					messageId: `msg_${sendCount}`,
					responseId: `resp_${sendCount}`,
					text: `Hello ${sendCount}`,
				});
			}
		}

		global.WebSocket = ReusableWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});

		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		});

		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(sendCount).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-reuse-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("websocket");
		expect(transportDetails.websocketConnected).toBe(true);
		expect(transportDetails.prewarmed).toBe(true);
		expect(transportDetails.canAppend).toBe(true);
	});

	it("scopes x-codex-turn-state to the current turn on SSE requests", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const requestTurnStates: Array<string | null> = [];
		let callCount = 0;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			requestTurnStates.push(headers.get("x-codex-turn-state"));
			const index = callCount;
			callCount += 1;
			const sse =
				index === 0
					? `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
						].join("\n\n")}\n\n`
					: `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: `msg_${index}`, role: "assistant", status: "in_progress", content: [] } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done" }] } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
						].join("\n\n")}\n\n`;
			// Every response mints a turn state; only within-turn follow-ups may echo it.
			const responseHeaders = new Headers({ "content-type": "text/event-stream" });
			responseHeaders.set("x-codex-turn-state", `turn-state-${index + 1}`);
			return new Response(sse, { status: 200, headers: responseHeaders });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const systemPrompt = ["You are a helpful assistant."];
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "turn-state-session",
			providerSessionState,
		};

		const first = await streamOpenAICodexResponses(model, { systemPrompt, messages: [firstUser] }, options).result();
		const toolCall = first.content.find(
			(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		expect(toolCall).toBeDefined();
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall!.id,
			toolName: toolCall!.name,
			content: [{ type: "text" as const, text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		// Tool-loop follow-up within the same turn replays the captured turn state.
		const second = await streamOpenAICodexResponses(
			model,
			{ systemPrompt, messages: [firstUser, first, toolResult] },
			options,
		).result();
		// A new user turn starts without it, even though the previous response minted one.
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt,
				messages: [
					firstUser,
					first,
					toolResult,
					second,
					{ role: "user" as const, content: "Next task", timestamp: Date.now() + 1 },
				],
			},
			options,
		).result();

		expect(requestTurnStates).toEqual([null, "turn-state-1", null]);
	});

	it("forces a fresh websocket when the prior connection has been idle past PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		// Tight reuse window so the test doesn't have to sleep for seconds. Disable
		// the heartbeat so it doesn't independently kill the idle socket and mask
		// the reuse-gate behaviour we're trying to verify.
		Bun.env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = "10";
		Bun.env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		let constructorCount = 0;
		let sendCount = 0;
		class IdleReuseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(_data: string): void {
				sendCount += 1;
				this.emitCodexResponse({
					messageId: `msg_${sendCount}`,
					responseId: `resp_${sendCount}`,
					text: `Hello ${sendCount}`,
				});
			}
		}

		global.WebSocket = IdleReuseWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-idle-reuse-session",
			providerSessionState,
		}).result();

		// Simulate the gap between a tool result and the continuation request: the
		// socket sat quiet long enough that we shouldn't trust it without a fresh
		// handshake. 30 ms > MAX_IDLE_REUSE_MS (10).
		await new Promise(resolve => setTimeout(resolve, 30));

		const second = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-idle-reuse-session",
			providerSessionState,
		}).result();

		expect(second.stopReason).toBe("stop");
		expect(constructorCount).toBe(2);
		expect(sendCount).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("drops stale frames from a prior response before sending the next websocket request", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		// Generous reuse window so the connection is happily reused across turns —
		// the queue-drain behaviour is the only variable here.
		Bun.env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = "60000";
		Bun.env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		let constructorCount = 0;
		let sendCount = 0;
		class LateFrameWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(_data: string): void {
				sendCount += 1;
				if (sendCount === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First",
					});
					// Stale frame that lands AFTER the consumer breaks on
					// response.completed. Without the queue-drain at the top of
					// streamRequest, this becomes the first frame of the next
					// request: a stale terminal event would resolve the new turn
					// with empty content, never reaching the model's real response.
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_stale", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_2",
					responseId: "resp_2",
					text: "Second",
				});
			}
		}

		global.WebSocket = LateFrameWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-stale-frame-session",
			providerSessionState,
		}).result();
		expect(first.stopReason).toBe("stop");

		const second = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-stale-frame-session",
			providerSessionState,
		}).result();

		expect(second.stopReason).toBe("stop");
		expect(constructorCount).toBe(1);
		expect(sendCount).toBe(2);
		// Second turn must reflect the second response, not the stale terminal frame
		// from the first turn's tail.
		expect(second.responseId).toBe("resp_2");
		const text = second.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map(c => c.text)
			.join("");
		expect(text).toBe("Second");
	});
});

describe("openai-codex SSE statelessness", () => {
	function createSseOptions(
		fetchMock: FetchImpl,
		sessionId: string,
		providerSessionState: Map<string, ProviderSessionState>,
	) {
		return {
			fetch: fetchMock,
			apiKey: createCodexTestToken(),
			sessionId,
			providerSessionState,
			preferWebsockets: false,
		};
	}

	function createCapturingFetch(sentRequests: Array<Record<string, unknown>>): FetchImpl {
		return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sentRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(createStatefulCodexSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as FetchImpl;
	}

	it("never sends previous_response_id over SSE; every turn replays the full transcript", async () => {
		// The HTTP endpoint's request schema has no `previous_response_id`
		// (codex-rs carries it only on websocket `response.create` frames);
		// strict chatgpt.com gateway validators 400 it with
		// `{"detail":"Unsupported parameter: previous_response_id"}`.
		const tempDir = TempDir.createSync("@pi-codex-sse-stateless-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = createSseOptions(fetchMock, "sse-stateless-session", providerSessionState);

		const systemPrompt = ["You are a helpful assistant."];
		const firstUser = { role: "user" as const, content: "First question", timestamp: Date.now() };
		const firstResponse = await streamOpenAICodexResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		expect(firstResponse.stopReason).toBe("stop");
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt,
				messages: [
					firstUser,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			options,
		).result();
		expect(secondResponse.stopReason).toBe("stop");

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		const secondInput = JSON.stringify(sentRequests[1]?.input);
		expect(secondInput).toContain("First question");
		expect(secondInput).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "sse-stateless-session",
			providerSessionState,
		});
		expect(stats).toMatchObject({ fullContextRequests: 2, deltaRequests: 0 });
	});
});
