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

	it("does not retry after the first event has been emitted", async () => {
		let authCalls = 0;
		const failure = authError();
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
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
});
