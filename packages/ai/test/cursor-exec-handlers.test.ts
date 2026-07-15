import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
	type BlockState,
	buildCursorHistoryForTest,
	buildCursorSystemPromptJsons,
	emptyGrepPatternRejection,
	handleServerMessage,
	resolveExecHandler,
	streamCursor,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import { streamCursor as lazyStreamCursor, setCursorProviderModule } from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context, CursorExecHandlers, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentRunRequest,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	ReadArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const cursorModel: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const cursorMaxModeModel: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5-max",
	name: "Cursor Composer 2.5 Max",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
	cursorMaxMode: true,
});

function captureCursorPayload(context: Context, model: Model<"cursor-agent"> = cursorModel): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(model, context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (isAgentRunRequest(payload)) {
				resolve(payload);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return !!payload && typeof payload === "object" && "$typeName" in payload;
}

function toolResultContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Use the read tool.", timestamp: 1 },
			{
				role: "assistant",
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-composer-2.5",
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
}

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

describe("Cursor request action encoding", () => {
	it("uses a resume action for empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "   ", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action for non-empty user turns", async () => {
		const payload = await captureCursorPayload({
			messages: [{ role: "user", content: "continue", timestamp: 0 }],
		});

		expect(payload.action?.action.case).toBe("userMessageAction");
	});

	it("sends Cursor max-mode metadata on model details and requested model", async () => {
		const payload = await captureCursorPayload(
			{
				messages: [{ role: "user", content: "continue", timestamp: 0 }],
			},
			cursorMaxModeModel,
		);

		expect(payload.modelDetails?.maxMode).toBe(true);
		expect(payload.requestedModel?.modelId).toBe("cursor-composer-2.5-max");
		expect(payload.requestedModel?.maxMode).toBe(true);
	});

	it("uses a resume action when a tool result is the final context message", async () => {
		const payload = await captureCursorPayload(toolResultContext());

		expect(payload.action?.action.case).toBe("resumeAction");
	});

	it("uses a user message action with selected context for image-only user turns", async () => {
		const imageData = "aW1hZ2U=";
		const payload = await captureCursorPayload({
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: imageData, mimeType: "image/png" }],
					timestamp: 0,
				},
			],
		});

		if (payload.action?.action.case !== "userMessageAction") {
			throw new Error("Expected Cursor userMessageAction");
		}
		const userMessage = payload.action.action.value.userMessage;
		expect(userMessage?.text).toBe("");
		expect(userMessage?.selectedContext?.selectedImages).toHaveLength(1);
		const selectedImage = userMessage?.selectedContext?.selectedImages[0];
		expect(selectedImage?.mimeType).toBe("image/png");
		if (selectedImage?.dataOrBlobId.case !== "data") {
			throw new Error("Expected Cursor selected image data");
		}
		expect(Array.from(selectedImage.dataOrBlobId.value)).toEqual(Array.from(Buffer.from(imageData, "base64")));
	});
});

describe("Cursor history encoding", () => {
	it("preserves image-only user turns in root prompt history and conversation turns", () => {
		const imageData = "aW1hZ2U=";
		const history = buildCursorHistoryForTest([
			{
				role: "user",
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
				timestamp: 0,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-composer-2.5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: "what is in the image?", timestamp: 0 },
		]);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "image", image: imageData, mediaType: "image/png" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I can see it." }],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([
			expect.objectContaining({
				selectedContext: {
					selectedImages: [
						expect.objectContaining({
							mimeType: "image/png",
							data: imageData,
						}),
					],
				},
			}),
		]);
	});

	it("preserves trailing tool result history for resume actions", () => {
		const history = buildCursorHistoryForTest(toolResultContext().messages, -1);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Use the read tool." }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "[Tool Result]\npackage contents" }],
			},
		]);
		expect(history.turnUserMessagesJson).toEqual([expect.objectContaining({ text: "Use the read tool." })]);
		expect(history.turnStepMessagesJson).toEqual([
			[expect.objectContaining({ assistantMessage: { text: "[Tool Result]\npackage contents" } })],
		]);
	});

	it("formats tool errors with [Tool Error] prefix", () => {
		const errorContext: Context = {
			messages: [
				{
					role: "user",
					content: "Search for nothing.",
					timestamp: 1,
				},
				{
					role: "assistant",
					api: "cursor-agent",
					provider: "cursor",
					model: "cursor-composer-2.5",
					content: [
						{
							type: "toolCall",
							id: "call-search",
							name: "search",
							arguments: { pattern: "" },
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
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: "Pattern must not be empty" }],
					isError: true,
					timestamp: 3,
				},
			],
		};

		const history = buildCursorHistoryForTest(errorContext.messages, -1);

		expect(history.rootPromptMessagesJson).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "Search for nothing." }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "[Tool Error]\nPattern must not be empty" }],
			},
		]);
		expect(history.turnStepMessagesJson).toEqual([
			[expect.objectContaining({ assistantMessage: { text: "[Tool Error]\nPattern must not be empty" } })],
		]);
	});
});

describe("Cursor grepArgs empty-pattern guard (issue #4574)", () => {
	it("returns null when the pattern is a non-empty regex", () => {
		expect(emptyGrepPatternRejection("foo", undefined)).toBeNull();
		expect(emptyGrepPatternRejection("foo", "**/*.ts")).toBeNull();
		// Whitespace-only patterns count as valid: leading/trailing whitespace is
		// meaningful in regexes (indentation anchors), matching the coding-agent
		// grep tool's own contract at packages/coding-agent/src/tools/grep.ts.
		expect(emptyGrepPatternRejection(" \tfoo ", undefined)).toBeNull();
	});

	it("rejects an empty pattern with a glob-aware hint when only a glob is present", () => {
		const message = emptyGrepPatternRejection("", "**/*snapcompact*");
		expect(message).not.toBeNull();
		expect(message).toContain("grep pattern is required");
		expect(message).toContain('"**/*snapcompact*"');
		expect(message).toContain("ls/read tool");
	});

	it("rejects an empty pattern with a plain message when no glob is present", () => {
		expect(emptyGrepPatternRejection("", undefined)).toBe("grep pattern is required (received an empty pattern).");
		expect(emptyGrepPatternRejection(undefined, undefined)).toBe(
			"grep pattern is required (received an empty pattern).",
		);
	});

	it("rejects a whitespace-only pattern the same way as an empty one", () => {
		expect(emptyGrepPatternRejection("   ", undefined)).toBe("grep pattern is required (received an empty pattern).");
		expect(emptyGrepPatternRejection("\t\n", "src/**/*.ts")).toContain('"src/**/*.ts"');
	});
});

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
}

describe("Cursor exec local-work tracking (issue #4593)", () => {
	it("marks the stream busy for the duration of a local exec handler", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];
		const handlerGate = Promise.withResolvers<void>();
		const execHandlers: CursorExecHandlers = {
			async read(args) {
				await handlerGate.promise;
				return {
					role: "toolResult",
					toolCallId: args.toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
		};
		const serverMsg = create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-1",
					message: {
						case: "readArgs",
						value: create(ReadArgsSchema, { path: "/tmp/slow-file", toolCallId: "call-read-1" }),
					},
				}),
			},
		});

		expect(stream.hasPendingLocalWork).toBe(false);
		const dispatch = handleServerMessage(
			serverMsg,
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		// The exec round-trip is in flight: the stream must advertise local
		// work so the lazy idle watchdog defers instead of aborting.
		expect(stream.hasPendingLocalWork).toBe(true);

		handlerGate.resolve();
		await dispatch;

		expect(stream.hasPendingLocalWork).toBe(false);
		// The read result went back out on the exec channel.
		expect(written.length).toBe(1);
	});

	it("survives a local exec tool outliving the lazy idle budget end to end", async () => {
		const workDone = Promise.withResolvers<void>();
		// The tracked work completes only once the lazy watchdog has consulted
		// the stream's local-work state at two expired deadlines, proving the
		// idle budget was truly exceeded while the exec tool ran.
		class ProbedStream extends AssistantMessageEventStream {
			probeCalls = 0;
			override get hasPendingLocalWork(): boolean {
				this.probeCalls++;
				if (this.probeCalls >= 2) workDone.resolve();
				return super.hasPendingLocalWork;
			}
		}
		const source = new ProbedStream();
		let providerSignal: AbortSignal | undefined;
		setCursorProviderModule({
			streamCursor: (_model, _context, options) => {
				providerSignal = options.signal;
				void (async () => {
					const partial = cursorAssistantMessage();
					source.push({ type: "start", partial });
					source.push({ type: "text_delta", contentIndex: 0, delta: "spawning local tool", partial });
					await source.trackLocalWork(workDone.promise);
					const message = cursorAssistantMessage();
					source.push({ type: "done", reason: "stop", message });
				})();
				return source;
			},
		});

		const stream = lazyStreamCursor(cursorModel, { messages: [] }, { apiKey: "test", streamIdleTimeoutMs: 5 });
		const result = await stream.result();

		expect(providerSignal?.aborted).toBe(false);
		expect(source.probeCalls).toBeGreaterThanOrEqual(2);
		expect(result.stopReason).toBe("stop");
	});

	it("still aborts a silent cursor stream with no local work in flight", async () => {
		const partial = cursorAssistantMessage();
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial } as const;
				const stalled = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					stalled.reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => stalled.reject(new Error("Request was aborted")), {
					once: true,
				});
				await stalled.promise;
			},
		} as unknown as AssistantMessageEventStream;
		setCursorProviderModule({
			streamCursor: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = lazyStreamCursor(cursorModel, { messages: [] }, { apiKey: "test", streamIdleTimeoutMs: 10 });
		const result = await stream.result();

		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});
});
