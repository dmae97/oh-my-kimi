import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import { buildOpenAiNativeHistory, requestOpenAiRemoteCompaction } from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function makeOpenAiModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

describe("buildOpenAiNativeHistory custom tool calls", () => {
	test("serializes customWireName tool calls as custom_tool_call + custom_tool_call_output", () => {
		const patch = "*** Begin Patch\n*** End Patch\n";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_apply_1|ctc_apply_1",
					name: "edit",
					arguments: { input: patch },
					customWireName: "apply_patch",
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_apply_1|ctc_apply_1",
			toolName: "edit",
			content: [{ type: "text", text: "patch applied" }],
			isError: false,
			timestamp: Date.now(),
		};

		const items = buildOpenAiNativeHistory([assistant, toolResult], makeOpenAiModel());

		const call = items.find(item => item.type === "custom_tool_call");
		expect(call).toBeDefined();
		expect(call?.name).toBe("apply_patch");
		expect(call?.input).toBe(patch);
		expect(call?.call_id).toBe("call_apply_1");

		const output = items.find(item => item.type === "custom_tool_call_output");
		expect(output).toBeDefined();
		expect(output?.call_id).toBe("call_apply_1");
		expect(output?.output).toBe("patch applied");

		// Did NOT emit the legacy function_call / function_call_output pair.
		expect(items.find(item => item.type === "function_call")).toBeUndefined();
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("continues to emit function_call for regular JSON tools", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read_1|fc_read_1",
					name: "read_file",
					arguments: { path: "/tmp/x" },
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		expect(items.find(item => item.type === "function_call")).toBeDefined();
		expect(items.find(item => item.type === "custom_tool_call")).toBeUndefined();
	});
});

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Codex carries native responses-API items on `providerPayload`. The history
// builder reads call ids from there (not the message content blocks), so each
// turn pairs a content `toolCall` (kept by `transformMessages` so the matching
// result survives) with a `providerPayload` function/custom call of the same id.
// `dt: true` appends to the running history; `dt: false` is a full snapshot that
// replaces it.
const CODEX_MODEL = makeOpenAiModel({ provider: "openai-codex" });

function codexAssistant(calls: Array<{ callId: string; custom?: boolean }>, dt: boolean): AssistantMessage {
	const content = calls.map(c => ({
		type: "toolCall" as const,
		id: `${c.callId}|${c.custom ? "ctc" : "fc"}_${c.callId}`,
		name: c.custom ? "edit" : "read",
		arguments: c.custom ? { input: "p" } : {},
		...(c.custom ? { customWireName: "apply_patch" } : {}),
	}));
	const items = calls.map(c =>
		c.custom
			? { type: "custom_tool_call", id: `ctc_${c.callId}`, call_id: c.callId, name: "apply_patch", input: "p" }
			: { type: "function_call", id: `fc_${c.callId}`, call_id: c.callId, name: "read", arguments: "{}" },
	);
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "openai-codex",
		model: "gpt-5",
		api: "openai-responses",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		providerPayload: { type: "openaiResponsesHistory", provider: "openai-codex", ...(dt ? { dt: true } : {}), items },
	} as unknown as AssistantMessage;
}

function toolResultFor(callId: string, custom = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${callId}|${custom ? "ctc" : "fc"}_${callId}`,
		toolName: custom ? "edit" : "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("buildOpenAiNativeHistory call-id tracking", () => {
	test("registers function_call ids carried in providerPayload so later tool results are emitted", () => {
		const items = buildOpenAiNativeHistory(
			[codexAssistant([{ callId: "call_1" }], true), toolResultFor("call_1")],
			CODEX_MODEL,
		);
		const output = items.find(item => item.type === "function_call_output");
		expect(output?.call_id).toBe("call_1");
		expect(items.find(item => item.type === "custom_tool_call_output")).toBeUndefined();
	});

	test("registers custom_tool_call ids from providerPayload so outputs use the custom wire shape", () => {
		const items = buildOpenAiNativeHistory(
			[codexAssistant([{ callId: "call_2", custom: true }], true), toolResultFor("call_2", true)],
			CODEX_MODEL,
		);
		expect(items.find(item => item.type === "custom_tool_call_output")?.call_id).toBe("call_2");
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("a full-snapshot providerPayload resets known call ids so stale outputs are dropped", () => {
		const items = buildOpenAiNativeHistory(
			[
				codexAssistant([{ callId: "call_old" }], true),
				// dt: false → splices the running history; call_old's function_call is gone.
				codexAssistant([{ callId: "call_new" }], false),
				toolResultFor("call_old"),
				toolResultFor("call_new"),
			],
			CODEX_MODEL,
		);
		expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_old")).toBe(false);
		expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_new")).toBe(true);
	});
});

describe("remote compaction input trimming", () => {
	test("trims custom tool outputs with their matching custom calls", async () => {
		let requestInput: Array<Record<string, unknown>> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		};

		await requestOpenAiRemoteCompaction(
			makeOpenAiModel({ contextWindow: 1 }),
			"test-key",
			[
				{ type: "custom_tool_call", call_id: "call_apply_1", name: "apply_patch", input: "x".repeat(10_000) },
				{ type: "custom_tool_call_output", call_id: "call_apply_1", output: "patch applied".repeat(1_000) },
			],
			"compact",
			undefined,
			{ fetch: fetchMock },
		);

		expect(requestInput?.some(item => item.type === "custom_tool_call")).toBe(false);
		expect(requestInput?.some(item => item.type === "custom_tool_call_output")).toBe(false);
	});
});

describe("requestOpenAiRemoteCompaction abort", () => {
	test("rejects when the abort signal is aborted mid-fetch", async () => {
		const controller = new AbortController();
		const fetchMock: FetchImpl = (_input, init) => {
			// Honor the provided abort signal: hang until aborted, then reject.
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				return promise;
			}
			signal?.addEventListener("abort", () => {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			});
			return promise;
		};

		const promise = requestOpenAiRemoteCompaction(
			makeOpenAiModel(),
			"test-key",
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			"compact",
			controller.signal,
			{ fetch: fetchMock },
		);

		queueMicrotask(() => controller.abort());

		await expect(promise).rejects.toThrow();
	});
});

describe("requestOpenAiRemoteCompaction timeout", () => {
	test("a never-responding endpoint rejects with TimeoutError instead of hanging", async () => {
		// Contract: the compact endpoint is a raw fetch outside the pi-ai stream
		// watchdogs — a silently dropped connection must not hang compaction
		// forever (frozen "Auto context-full maintenance…" spinner).
		const fetchMock: FetchImpl = (_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener("abort", () => reject(signal.reason));
			return promise;
		};

		await expect(
			requestOpenAiRemoteCompaction(
				makeOpenAiModel(),
				"test-key",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
				undefined,
				{ fetch: fetchMock, timeoutMs: 20 },
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});
});

describe("compact() remote compaction failure handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function localSummaryMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			provider: "mock",
			model: "mock",
			api: "mock",
			usage: ZERO_USAGE,
			stopReason: "stop",
		};
	}

	function makePreparation(): CompactionPreparation {
		return {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
			isSplitTurn: false,
			tokensBefore: 100_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		};
	}

	test("user abort during the remote compact request rejects without falling back to local summarization", async () => {
		// Contract: Esc is a cancellation, not a remote failure. Before the fix
		// the AbortError was swallowed by the fallback catch and compaction kept
		// running local summarization on an already-aborted signal.
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const controller = new AbortController();
		const fetchMock: FetchImpl = (_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			const fail = () =>
				reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail);
			// Esc lands while the compact POST is in flight.
			queueMicrotask(() => controller.abort());
			return promise;
		};

		await expect(
			compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, controller.signal, {
				fetch: fetchMock,
			}),
		).rejects.toThrow();
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("remote compact server failure without abort still falls back to local summarization", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const fetchMock: FetchImpl = async () =>
			new Response("nope", { status: 500, statusText: "Internal Server Error" });

		const result = await compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, undefined, {
			fetch: fetchMock,
		});

		expect(result.summary).toContain("local summary");
		expect(completeSpy).toHaveBeenCalled();
	});
});
