import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const SOURCE_ID = "stream-auth-retry-test";
const API = "stream-auth-retry-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantError(errorMessage: string, errorStatus?: number): AssistantMessage {
	return { ...assistant(), stopReason: "error", errorMessage, errorStatus };
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: API,
		provider: "test-provider",
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 1024,
	};
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("streamSimple auth retry", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("retries once with a fresh key when 401 happens before the first event", async () => {
		const keys: Array<string | undefined> = [];
		let authCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.fail(authError());
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async (provider, oldKey, error) => {
				authCalls += 1;
				expect(provider).toBe("test-provider");
				expect(oldKey).toBe("old-key");
				expect((error as { status?: number }).status).toBe(401);
				return "new-key";
			},
		});

		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(authCalls).toBe(1);
	});

	it("retries when a provider emits start then a 401 error event before content", async () => {
		const keys: Array<string | undefined> = [];
		const eventTypes: string[] = [];
		let authCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError(
								'Error: 401\n{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
							),
						});
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async (provider, oldKey, error) => {
				authCalls += 1;
				expect(provider).toBe("test-provider");
				expect(oldKey).toBe("old-key");
				expect((error as { status?: number }).status).toBe(401);
				return "new-key";
			},
		});

		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(eventTypes).toEqual(["start", "done"]);
		expect(authCalls).toBe(1);
	});

	it("does not retry after replay-unsafe content has been emitted", async () => {
		let authCalls = 0;
		const failure = authError();
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.fail(failure);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				authCalls += 1;
				return "new-key";
			},
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(failure);
		expect(authCalls).toBe(0);
	});

	it("retries on 401 carried via errorStatus when the message has no parseable status", async () => {
		const keys: Array<string | undefined> = [];
		let authCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							// Realistic Anthropic SDK shape: message begins with `<status> <body>`
							// and the regex fallback in extractHttpStatusFromError cannot find 401
							// inside the JSON body. Only `errorStatus` carries the signal.
							error: assistantError(
								'{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
								401,
							),
						});
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				authCalls += 1;
				return "new-key";
			},
		});

		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(authCalls).toBe(1);
	});

	it("retries on a thrown usage_limit_reached error before any event has been emitted", async () => {
		const keys: Array<string | undefined> = [];
		const errors: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.fail(
							Object.assign(
								new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
								{ status: 429 },
							),
						);
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async (_provider, _oldKey, error) => {
				errors.push(error);
				return "new-key";
			},
		});

		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(errors).toHaveLength(1);
		// The error surfaced to onAuthError carries the original 429 status so
		// the gateway's refresh hook can branch on it.
		expect((errors[0] as { status?: number }).status).toBe(429);
		expect((errors[0] as Error).message).toMatch(/usage limit/i);
	});

	it("retries when a provider emits a usage_limit_reached error event before content", async () => {
		const keys: Array<string | undefined> = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							// errorStatus deliberately omitted: matches how the codex
							// provider serializes the message-only path that used to
							// 502 in the gateway.
							error: assistantError("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
						});
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => "new-key",
		});

		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
	});

	it("surfaces the original usage_limit error when the retry callback declines", async () => {
		const keys: Array<string | undefined> = [];
		const original = Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan)."), { status: 429 });
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(original));
				return stream;
			},
			SOURCE_ID,
		);

		// Callback returns undefined → no sibling credential to rotate to.
		// The original failure must reach the caller untouched so the client
		// can decide what to do (back off, surface to user, …).
		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => undefined,
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(original);
		// Single attempt — the inner stream is only re-invoked when a new key
		// is provided.
		expect(keys).toEqual(["old-key"]);
	});
});
