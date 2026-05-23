import { afterEach, describe, expect, it, vi } from "bun:test";
import http2 from "node:http2";
import { buildCursorSystemPromptJsons, resolveExecHandler, streamCursor } from "../src/providers/cursor";
import type { Context, Model } from "../src/types";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cursor resolveExecHandler execHandlers binding", () => {
	it("invokes handler with correct this when passed as bound method", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				// Handler methods rely on 'this' (e.g. to access other handlers or state).
				// When passed without .bind(handlers), 'this' is undefined in strict mode.
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read.bind(handlers),
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			() => ({ tag: "error" }),
		);

		expect(execResult).toBe(sentinel);
		expect((execResult as { tag: string }).tag).toBe("bound-correctly");
	});

	it("handler loses this when passed unbound and fails or returns wrong result", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		// Pass method reference without .bind(handlers). In strict mode 'this' is undefined
		// when resolveExecHandler calls handler(args), so (this as any).sentinel throws.
		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read,
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			(msg: string) => ({ tag: "error", message: msg }),
		);

		// Should get error result (handler threw accessing undefined.sentinel)
		expect(execResult).toEqual({ tag: "error", message: expect.any(String) });
	});
});

describe("Cursor system prompt encoding", () => {
	it("emits one Cursor system blob per ordered prompt", () => {
		const jsons = buildCursorSystemPromptJsons(["Primary instructions.", "Developer constraints."]);
		expect(jsons).toHaveLength(2);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "Primary instructions." });
		expect(JSON.parse(jsons[1])).toEqual({ role: "system", content: "Developer constraints." });
	});

	it("falls back to a single default system message when all entries are empty", () => {
		const jsons = buildCursorSystemPromptJsons(["", ""]);
		expect(jsons).toHaveLength(1);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "You are a helpful assistant." });
	});
});
describe("Cursor stream request assembly", () => {
	it("uses the latest user message when a tool result is the final context message", async () => {
		const model: Model<"cursor-agent"> = {
			id: "cursor-test",
			name: "Cursor Test",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://cursor.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_000,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Use the read tool.", timestamp: 1 },
				{
					role: "assistant",
					api: "cursor-agent",
					provider: "cursor",
					model: "cursor-test",
					content: [
						{
							type: "toolCall",
							id: "call-read",
							name: "read",
							arguments: { path: "package.json" },
						},
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: "package contents" }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		const connect = vi.spyOn(http2, "connect").mockImplementation(() => {
			throw new Error("request built");
		});

		const result = await streamCursor(model, context, {
			apiKey: "cursor-test-token",
			sessionId: "cursor-last-user-regression",
		}).result();

		expect(connect).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("request built");
		expect(result.errorMessage).not.toContain("Cannot send empty user message");
	});
});
