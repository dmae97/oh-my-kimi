import { afterEach, describe, expect, it, vi } from "bun:test";
import { enrichModelThinking } from "@oh-my-pi/pi-ai/model-thinking";
import {
	getOpenAICodexTransportDetails,
	getOpenAICodexWebSocketDebugStats,
	prewarmOpenAICodexResponses,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const originalCodexWebSocketRetryBudget = Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET;
const originalCodexWebSocketRetryDelayMs = Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS;
const originalCodexWebSocketIdleTimeoutMs = Bun.env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
const originalCodexWebSocketFirstEventTimeoutMs = Bun.env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS;
const originalCodexWebSocketV2 = Bun.env.PI_CODEX_WEBSOCKET_V2;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	global.fetch = originalFetch;
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	restoreEnv("PI_CODEX_WEBSOCKET_RETRY_BUDGET", originalCodexWebSocketRetryBudget);
	restoreEnv("PI_CODEX_WEBSOCKET_RETRY_DELAY_MS", originalCodexWebSocketRetryDelayMs);
	restoreEnv("PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS", originalCodexWebSocketIdleTimeoutMs);
	restoreEnv("PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS", originalCodexWebSocketFirstEventTimeoutMs);
	restoreEnv("PI_CODEX_WEBSOCKET_V2", originalCodexWebSocketV2);
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
	return {
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
	};
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
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

function encodeWebSocketMessage(value: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function createMessageEvent(data: unknown): MessageEvent {
	return new MessageEvent("message", { data });
}

function emitWebSocketEvent(listeners: Map<string, Set<(event: Event) => void>>, type: string, event: Event): void {
	const eventListeners = listeners.get(type);
	if (!eventListeners) return;
	for (const listener of eventListeners) {
		listener(event);
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
		global.fetch = vi.fn(async (input: string | URL) => {
			requestedUrls.push(typeof input === "string" ? input : input.toString());
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		for (const baseUrl of [
			undefined,
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
		]) {
			const model = { ...createCodexTestModel(baseUrl), preferWebsockets: false };
			const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(requestedUrls).toEqual([
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
		]);
	});

	it("parses websocket JSON from non-string payloads", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		type WsListener = (event: Event) => void;
		class BinaryPayloadWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = BinaryPayloadWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = BinaryPayloadWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				this.#listeners.get(type)?.delete(listener as WsListener);
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
					response: {
						id: "resp_ws",
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				});
				this.#emit(
					"message",
					createMessageEvent(added.buffer.slice(added.byteOffset, added.byteOffset + added.byteLength)),
				);
				this.#emit("message", createMessageEvent(contentPart));
				this.#emit("message", createMessageEvent(new DataView(delta.buffer, delta.byteOffset, delta.byteLength)));
				this.#emit("message", createMessageEvent(new Blob([done])));
				this.#emit(
					"message",
					createMessageEvent(
						completed.buffer.slice(completed.byteOffset, completed.byteOffset + completed.byteLength),
					),
				);
			}

			close(): void {
				this.readyState = BinaryPayloadWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				emitWebSocketEvent(this.#listeners, type, event);
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

	it("omits request-body headers and replaces stale beta headers for websocket handshakes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let capturedHeaders: Record<string, string> | undefined;
		type WsListener = (event: Event) => void;
		class HeaderCaptureWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = HeaderCaptureWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, options?: { headers?: Record<string, string> }) {
				capturedHeaders = options?.headers;
				setTimeout(() => {
					this.readyState = HeaderCaptureWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				this.#listeners.get(type)?.delete(listener as WsListener);
			}

			send(): void {
				this.#emit(
					"message",
					createMessageEvent(
						JSON.stringify({
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
						}),
					),
				);
			}

			close(): void {
				this.readyState = HeaderCaptureWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				emitWebSocketEvent(this.#listeners, type, event);
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

		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token });
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
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
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

		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
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
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
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
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
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

		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, sessionId });
		await streamResult.result();
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

		global.fetch = fetchMock as unknown as typeof fetch;

		const model = enrichModelThinking({
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
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
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

		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		// No sessionId provided
		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token });
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
		global.fetch = fetchMock as unknown as typeof fetch;
		type WsListener = (event: Event) => void;
		class FailingWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = FailingWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();
			url: string;
			options?: { headers?: Record<string, string> };

			constructor(url: string, options?: { headers?: Record<string, string> }) {
				this.url = url;
				this.options = options;
				setTimeout(() => {
					expect(this.options?.headers?.["OpenAI-Beta"] ?? this.options?.headers?.["openai-beta"]).toStartWith(
						"responses_websockets=",
					);
					this.#emit("error", new Event("error"));
					this.#emit("close", new Event("close"));
					this.readyState = FailingWebSocket.CLOSED;
				}, 0);
			}
			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}
			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {}
			close(): void {
				this.readyState = FailingWebSocket.CLOSED;
			}
			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const streamResult = streamOpenAICodexResponses(model, context, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		let constructorCount = 0;
		class FailingConnectWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = FailingConnectWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				constructorCount += 1;
				setTimeout(() => {
					this.#emit("error", new Event("error"));
					this.#emit("close", new Event("close"));
					this.readyState = FailingConnectWebSocket.CLOSED;
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {}
			close(): void {
				this.readyState = FailingConnectWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = FailingConnectWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class HandshakeWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = HandshakeWebSocket.CONNECTING;
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "models-etag-1",
				"x-reasoning-included": "true",
			};
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = HandshakeWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: "Hello WS" }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_ws",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello WS" }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: "resp_ws",
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			close(): void {
				this.readyState = HandshakeWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = HandshakeWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = {
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
		};
		const sseModel: Model<"openai-codex-responses"> = {
			...websocketModel,
			preferWebsockets: false,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(websocketModel, context, {
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(sseModel, context, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class ServiceTierWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = ServiceTierWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = ServiceTierWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: "Hello WS" }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_ws",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello WS" }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.created", response: { id: "resp_ws" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: "resp_ws",
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			close(): void {
				this.readyState = ServiceTierWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = ServiceTierWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			serviceTier: "priority",
			sessionId: "ws-service-tier-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests[0]?.type).toBe("response.create");
		expect(sentRequests[0]?.service_tier).toBe("priority");
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class DeltaWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = DeltaWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = DeltaWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const responseIndex = sentRequests.length;
				const responseId = `resp_${responseIndex}`;
				const messageId = `msg_${responseIndex}`;
				const text = responseIndex === 1 ? "First answer" : "Second answer";
				this.#emit("message", {
					data: JSON.stringify({ type: "response.created", response: { id: responseId } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: text }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: responseId,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			close(): void {
				this.readyState = DeltaWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = DeltaWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() },
			],
		};
		await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[0]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[1]?.type).toBe("response.create");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.prompt_cache_key).toBe("ws-delta-session");
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
		global.fetch = fetchMock as unknown as typeof fetch;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		await streamOpenAICodexResponses(model, context, { apiKey: token, textVerbosity: "high" }).result();

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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class WebSocketV2HeaderProbe {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = WebSocketV2HeaderProbe.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, options?: { headers?: Record<string, string> }) {
				expect(options?.headers?.["OpenAI-Beta"] ?? options?.headers?.["openai-beta"]).toBe(
					"responses_websockets=2026-02-06",
				);
				setTimeout(() => {
					this.readyState = WebSocketV2HeaderProbe.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_v2", role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: "Hello v2" }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_v2",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello v2" }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: "resp_v2",
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			close(): void {
				this.readyState = WebSocketV2HeaderProbe.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = WebSocketV2HeaderProbe as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-v2-session",
			providerSessionState,
		}).result();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to SSE when a prewarmed websocket never produces a first event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = "10";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse_first_event", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello fallback" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse_first_event", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello fallback" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { id: "resp_sse_first_event", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async () => {
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		let sendCount = 0;
		class IdleWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = IdleWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = IdleWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {
				sendCount += 1;
			}

			close(): void {
				this.readyState = IdleWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = IdleWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		}).result();
		expect(sendCount).toBeGreaterThanOrEqual(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
		expect(transportDetails.fallbackCount).toBe(1);
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		let constructorCount = 0;
		const requestTypes: string[] = [];

		class FlakyCloseWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = FlakyCloseWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				constructorCount += 1;
				setTimeout(() => {
					this.readyState = FlakyCloseWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				if (requestTypes.length === 1) {
					this.readyState = FlakyCloseWebSocket.CLOSED;
					this.#emit("close", { code: 1012 } as unknown as Event);
					return;
				}
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "msg_retry_close",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: "Hello retry close" }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_retry_close",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello retry close" }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: "resp_retry_close",
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			close(): void {
				this.readyState = FlakyCloseWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = FlakyCloseWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class UnavailableBeforeStreamWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = UnavailableBeforeStreamWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = UnavailableBeforeStreamWebSocket.OPEN;
					this.#emit("open", new Event("open"));
					this.readyState = UnavailableBeforeStreamWebSocket.CLOSED;
					this.#emit("close", { code: 1006 } as unknown as Event);
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {}

			close(): void {
				this.readyState = UnavailableBeforeStreamWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = UnavailableBeforeStreamWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		const sentTypesByConnection: string[][] = [];
		let constructorCount = 0;
		let abortSecondRequest: (() => void) | undefined;

		class AbortResetWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = AbortResetWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();
			#connectionIndex: number;

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				this.#connectionIndex = constructorCount;
				constructorCount += 1;
				sentTypesByConnection[this.#connectionIndex] = [];
				setTimeout(() => {
					this.readyState = AbortResetWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypesByConnection[this.#connectionIndex]?.push(requestType);
				const requestIndex = sentTypesByConnection[this.#connectionIndex]?.length ?? 0;

				if (this.#connectionIndex === 0 && requestIndex === 1) {
					this.#emitCompleted("msg_1", "resp_1", "Hello one");
					return;
				}
				if (this.#connectionIndex === 0 && requestIndex === 2) {
					this.#emit("message", {
						data: JSON.stringify({
							type: "response.output_item.added",
							item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
						}),
					} as unknown as Event);
					this.#emit("message", {
						data: JSON.stringify({
							type: "response.content_part.added",
							part: { type: "output_text", text: "" },
						}),
					} as unknown as Event);
					this.#emit("message", {
						data: JSON.stringify({ type: "response.output_text.delta", delta: "Still streaming" }),
					} as unknown as Event);
					setTimeout(() => {
						abortSecondRequest?.();
					}, 0);
					return;
				}
				if (this.#connectionIndex === 1 && requestIndex === 1) {
					expect(requestType).toBe("response.create");
					this.#emitCompleted("msg_3", "resp_3", "Hello three");
					return;
				}
				throw new Error(`Unexpected websocket send sequence: ${this.#connectionIndex}:${requestIndex}`);
			}

			close(): void {
				this.readyState = AbortResetWebSocket.CLOSED;
			}

			#emitCompleted(messageId: string, responseId: string, text: string): void {
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: text }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: responseId,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = AbortResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
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
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			signal: secondAbortController.signal,
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("aborted");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		const sentTypes: string[] = [];
		let constructorCount = 0;

		class ErrorResetWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = ErrorResetWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				constructorCount += 1;
				setTimeout(() => {
					this.readyState = ErrorResetWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypes.push(requestType);
				const requestIndex = sentTypes.length;

				if (requestIndex === 1) {
					this.#emitCompleted("msg_1", "resp_1", "Hello one");
					return;
				}
				if (requestIndex === 2) {
					this.#emit("message", {
						data: JSON.stringify({
							type: "error",
							code: "invalid_request_error",
							message: "simulated request error",
						}),
					} as unknown as Event);
					return;
				}
				if (requestIndex === 3) {
					expect(requestType).toBe("response.create");
					this.#emitCompleted("msg_3", "resp_3", "Hello three");
					return;
				}
				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}

			close(): void {
				this.readyState = ErrorResetWebSocket.CLOSED;
			}

			#emitCompleted(messageId: string, responseId: string, text: string): void {
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: text }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: responseId,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = ErrorResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(firstResult.role).toBe("assistant");

		const secondResult = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("error");
		expect(secondResult.errorMessage).toContain("simulated request error");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class MalformedMessageWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = MalformedMessageWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = MalformedMessageWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {
				this.#emit("message", { data: "{" } as unknown as Event);
			}

			close(): void {
				this.readyState = MalformedMessageWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = MalformedMessageWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		class BufferedCloseWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = BufferedCloseWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = BufferedCloseWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(): void {
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "msg_ws_partial",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: "Partial output" }),
				} as unknown as Event);
				this.readyState = BufferedCloseWebSocket.CLOSED;
				this.#emit("close", { code: 1006 } as unknown as Event);
			}

			close(): void {
				this.readyState = BufferedCloseWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = BufferedCloseWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
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
		};
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		const requestTypes: string[] = [];
		class DivergedAppendWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = DivergedAppendWebSocket.CONNECTING;
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "ws-models-etag-1",
			};
			#listeners = new Map<string, Set<WsListener>>();
			#sendCount = 0;

			constructor(_url: string, _options?: { headers?: Record<string, string> }) {
				setTimeout(() => {
					this.readyState = DivergedAppendWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				this.#sendCount += 1;
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				const idSuffix = String(this.#sendCount);
				this.#emitCompleted(`msg_${idSuffix}`, `resp_${idSuffix}`, `Hello WS ${idSuffix}`);
			}

			close(): void {
				this.readyState = DivergedAppendWebSocket.CLOSED;
			}

			#emitCompleted(messageId: string, responseId: string, text: string): void {
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: text }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: responseId,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = DivergedAppendWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = {
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
		};
		const sseModel: Model<"openai-codex-responses"> = {
			...websocketModel,
			preferWebsockets: false,
		};
		const firstContext: Context = {
			systemPrompt: "Prompt A",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: "Prompt B",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		await streamOpenAICodexResponses(websocketModel, firstContext, {
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(websocketModel, secondContext, {
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(sseModel, secondContext, {
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
		global.fetch = fetchMock as unknown as typeof fetch;

		type WsListener = (event: Event) => void;
		let constructorCount = 0;
		let sendCount = 0;
		class ReusableWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;

			readyState = ReusableWebSocket.CONNECTING;
			#listeners = new Map<string, Set<WsListener>>();

			constructor(
				public readonly url: string,
				public readonly options?: { headers?: Record<string, string> },
			) {
				constructorCount += 1;
				setTimeout(() => {
					this.readyState = ReusableWebSocket.OPEN;
					this.#emit("open", new Event("open"));
				}, 0);
			}

			addEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type) ?? new Set<WsListener>();
				listeners.add(listener as WsListener);
				this.#listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: unknown): void {
				if (typeof listener !== "function") return;
				const listeners = this.#listeners.get(type);
				listeners?.delete(listener as WsListener);
			}

			send(data: string): void {
				sendCount += 1;
				const request = JSON.parse(data) as Record<string, unknown>;
				expect(typeof request.type).toBe("string");
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: `msg_${sendCount}`,
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({ type: "response.output_text.delta", delta: `Hello ${sendCount}` }),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: `msg_${sendCount}`,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: `Hello ${sendCount}` }],
						},
					}),
				} as unknown as Event);
				this.#emit("message", {
					data: JSON.stringify({
						type: "response.done",
						response: {
							id: `resp_${sendCount}`,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					}),
				} as unknown as Event);
			}

			close(): void {
				this.readyState = ReusableWebSocket.CLOSED;
			}

			#emit(type: string, event: Event): void {
				const listeners = this.#listeners.get(type);
				if (!listeners) return;
				for (const listener of listeners) {
					listener(event);
				}
			}
		}

		global.WebSocket = ReusableWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, { apiKey: token, sessionId: "ws-reuse-session", providerSessionState });

		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(model, secondContext, {
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

	it("replays x-codex-turn-state on subsequent SSE requests", async () => {
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
			const sse = `${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: `msg_${callCount}`, role: "assistant", status: "in_progress", content: [] } })}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: `msg_${callCount}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			].join("\n\n")}\n\n`;
			const responseHeaders = new Headers({ "content-type": "text/event-stream" });
			if (callCount === 0) {
				responseHeaders.set("x-codex-turn-state", "turn-state-1");
			}
			callCount += 1;
			return new Response(sse, { status: 200, headers: responseHeaders });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
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
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "turn-state-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "turn-state-session",
			providerSessionState,
		}).result();

		expect(requestTurnStates[0]).toBeNull();
		expect(requestTurnStates[1]).toBe("turn-state-1");
	});
});
