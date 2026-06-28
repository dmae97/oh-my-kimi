import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	buildCompactionV2Request,
	buildOpenAiNativeHistory,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	shouldUseCompactionV2Streaming,
	shouldUseOpenAiRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";

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

function makeAzureModel(overrides: Partial<ModelSpec<"azure-openai-responses">> = {}): Model<"azure-openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5 Azure",
		api: "azure-openai-responses",
		provider: "azure-openai",
		baseUrl: "https://example-resource.openai.azure.com/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
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

describe("remote compaction input forwarding", () => {
	test("sends the full native history without local trimming", async () => {
		// Contract: the compact endpoint owns compression. Trimming locally dropped
		// assistant turns + encrypted reasoning before the provider ever saw them,
		// so the client now forwards the full input untouched even on a tiny window.
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

		expect(requestInput?.some(item => item.type === "custom_tool_call")).toBe(true);
		expect(requestInput?.some(item => item.type === "custom_tool_call_output")).toBe(true);
	});
});

describe("requestCompactionV2Streaming", () => {
	test("posts a compaction_trigger Responses stream and installs Codex-style replacement history", async () => {
		const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };
		const compactionItem = { type: "compaction", encrypted_content: "enc_123" };
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
				model: "gpt-5-compact",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[
				{ type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\nrepo" }] },
				userItem,
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
			],
			"instructions",
			{ sessionId: "session-1", promptCacheKey: "cache-1" },
		);
		let requestBody: { model: string; input: Array<Record<string, unknown>>; prompt_cache_key?: string } | undefined;
		let sessionHeader: string | undefined;
		let clientRequestHeader: string | undefined;
		let legacySessionHeader: string | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			expect(String(input)).toBe("https://compact.example/v1/responses");
			if (!init?.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
				throw new Error("Expected V2 compaction to send headers as a plain object");
			}
			const rawSessionHeader = init.headers.session_id;
			const rawClientRequestHeader = init.headers["x-client-request-id"];
			const rawLegacySessionHeader = init.headers["session-id"];
			sessionHeader = typeof rawSessionHeader === "string" ? rawSessionHeader : undefined;
			clientRequestHeader = typeof rawClientRequestHeader === "string" ? rawClientRequestHeader : undefined;
			legacySessionHeader = typeof rawLegacySessionHeader === "string" ? rawLegacySessionHeader : undefined;
			requestBody = JSON.parse(String(init.body)) as {
				model: string;
				input: Array<Record<string, unknown>>;
				prompt_cache_key?: string;
			};
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
				},
				{ type: "response.output_item.done", output_index: 1, item: compactionItem },
				{
					type: "response.completed",
					response: {
						usage: {
							input_tokens: 123,
							output_tokens: 4,
							total_tokens: 127,
							input_tokens_details: { cached_tokens: 7 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				},
			]);
		};

		expect(shouldUseCompactionV2Streaming(model)).toBe(true);
		const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, { fetch: fetchMock });

		expect(sessionHeader).toBe("session-1");
		expect(clientRequestHeader).toBe("session-1");
		expect(legacySessionHeader).toBeUndefined();
		expect(requestBody?.model).toBe("gpt-5-compact");
		expect(requestBody?.prompt_cache_key).toBe("cache-1");
		expect(requestBody?.input[requestBody.input.length - 1]).toEqual({ type: "compaction_trigger" });
		expect(result.replacementHistory).toEqual([userItem, compactionItem]);
		expect(result.usedTokens).toBe(123);
		expect(result.usage?.cachedInputTokens).toBe(7);
		expect(result.usage?.reasoningOutputTokens).toBe(1);
	});

	test("retries transient V2 stream failures with a fresh request attempt", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		let attempts = 0;
		const fetchMock: FetchImpl = async () => {
			attempts++;
			if (attempts === 1) {
				return new Response("try again", { status: 500, statusText: "Internal Server Error" });
			}
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc" },
				},
				{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
			]);
		};

		await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		});

		expect(attempts).toBe(2);
	});
});

test("uses configured OpenAI-compatible compaction for custom providers", async () => {
	const model = makeOpenAiModel({
		provider: "cliproxy-codex",
		baseUrl: "http://127.0.0.1:8317/v1",
		remoteCompaction: {
			enabled: true,
			api: "openai-responses",
			endpoint: "http://127.0.0.1:8317/v1/responses/compact",
			model: "gpt-5.5",
		},
	});
	let requestBody: unknown;
	const fetchMock: FetchImpl = async (input, init) => {
		expect(String(input)).toBe("http://127.0.0.1:8317/v1/responses/compact");
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				output: [{ type: "compaction_summary", summary: "native compacted" }],
			}),
		);
	};

	expect(shouldUseOpenAiRemoteCompaction(model)).toBe(true);
	await requestOpenAiRemoteCompaction(
		model,
		"test-key",
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
		undefined,
		{ fetch: fetchMock },
	);
	expect(requestBody).toMatchObject({ model: "gpt-5.5" });
});

test("uses Azure request shape for Azure Responses remote compaction", async () => {
	const previousDeploymentMap = Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-5-compact=azure-gpt-5-compact";
	const model = makeAzureModel({
		headers: { "x-custom-header": "custom" },
		remoteCompaction: {
			enabled: true,
			api: "azure-openai-responses",
			model: "gpt-5-compact",
		},
	});
	let requestBody: unknown;
	let requestApiKey: string | undefined;
	let requestAuthorization: string | undefined;
	let requestContentType: string | undefined;
	let requestCustomHeader: string | undefined;
	const stringHeader = (value: string | readonly string[] | undefined): string | undefined =>
		typeof value === "string" ? value : undefined;
	const fetchMock: FetchImpl = async (input, init) => {
		expect(String(input)).toBe(
			"https://example-resource.openai.azure.com/openai/v1/responses/compact?api-version=v1",
		);
		if (!init?.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
			throw new Error("Expected remote compaction to send headers as a plain object");
		}
		requestApiKey = stringHeader(init.headers["api-key"]);
		requestAuthorization = stringHeader(init.headers.Authorization);
		requestContentType = stringHeader(init.headers["content-type"]);
		requestCustomHeader = stringHeader(init.headers["x-custom-header"]);
		requestBody = JSON.parse(String(init.body));
		return Response.json({
			output: [{ type: "compaction_summary", summary: "azure compacted" }],
		});
	};

	expect(shouldUseOpenAiRemoteCompaction(model)).toBe(true);
	await requestOpenAiRemoteCompaction(
		model,
		"azure-key",
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
		undefined,
		{ fetch: fetchMock },
	);

	expect(requestApiKey).toBe("azure-key");
	expect(requestAuthorization).toBeUndefined();
	expect(requestContentType).toBe("application/json");
	expect(requestCustomHeader).toBe("custom");
	expect(requestBody).toMatchObject({ model: "azure-gpt-5-compact" });
	if (previousDeploymentMap === undefined) {
		delete Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	} else {
		Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousDeploymentMap;
	}
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
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteStreamingV2Enabled: false },
		};
	}

	test("streams V2 compaction before V1 when both settings and model opt in", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteStreamingV2Enabled: true,
		};
		preparation.messagesToSummarize = [
			{ role: "user", content: "first user request", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "hidden reasoning",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_test",
							encrypted_content: "encrypted reasoning",
							summary: [],
						}),
					},
					{ type: "text", text: "assistant visible answer" },
					{ type: "toolCall", id: "call_read_1|fc_read_1", name: "read", arguments: { path: "/tmp/x" } },
				],
				timestamp: 2,
				provider: "openai",
				model: "gpt-5",
				api: "openai-responses",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_read_1|fc_read_1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			},
		];
		preparation.recentMessages = [{ role: "user", content: "second user request", timestamp: 4 }];
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		let requestBody: { input: Array<Record<string, unknown>>; reasoning?: Record<string, unknown> } | undefined;
		let calls = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			calls++;
			requestBody = JSON.parse(String(init?.body)) as {
				input: Array<Record<string, unknown>>;
				reasoning?: Record<string, unknown>;
			};
			return sseResponse([
				{ type: "response.output_item.done", output_index: 0, item: compactionItem },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 55, output_tokens: 3, total_tokens: 58 } },
				},
			]);
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, {
			fetch: fetchMock,
		});

		const input = requestBody?.input ?? [];
		const inputText = input.flatMap(item =>
			Array.isArray(item.content)
				? item.content.filter(isRecord).map(part => (typeof part.text === "string" ? part.text : ""))
				: [],
		);
		expect(calls).toBe(1);
		// Faithful Codex V2 shape: the trigger is the final input item.
		expect(input[input.length - 1]).toEqual({ type: "compaction_trigger" });
		// Conversation turns survive translation — user prompts, assistant prose, reasoning, and the tool pair.
		expect(inputText).toContain("first user request");
		expect(inputText).toContain("assistant visible answer");
		expect(inputText).toContain("second user request");
		expect(input.some(item => item.type === "reasoning")).toBe(true);
		expect(input.some(item => item.type === "function_call" && item.name === "read")).toBe(true);
		expect(input.some(item => item.type === "function_call_output")).toBe(true);
		// Reasoning effort is sent like a normal turn (gpt-5 is a reasoning model).
		expect(requestBody?.reasoning).toMatchObject({ effort: "high", summary: "auto" });
		const remote = getCompactionV2PreserveData(result.preserveData);
		expect(remote?.usedTokens).toBe(55);
		expect(remote?.replacementHistory.at(-1)).toEqual(compactionItem);
		expect(result.summary).toContain("Remote compaction preserved provider-native history");
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("re-expands a prior V2 compaction's originals when no candidate can reuse the replay", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("re-expanded local summary"));
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const v2Model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		// Produce a real V2 preserve payload (opaque placeholder summary, provider "openai").
		const v2Preparation = makePreparation();
		v2Preparation.messagesToSummarize = [{ role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 }];
		v2Preparation.recentMessages = [{ role: "user", content: "turn after", timestamp: 2 }];
		v2Preparation.settings = { ...v2Preparation.settings, remoteStreamingV2Enabled: true };
		const v2Result = await compact(v2Preparation, v2Model, "k", undefined, undefined, {
			fetch: async () =>
				sseResponse([
					{ type: "response.output_item.done", output_index: 0, item: compactionItem },
					{
						type: "response.completed",
						response: { usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } },
					},
				]),
		});
		// V2 success persists only the opaque placeholder — no second local summarization round.
		expect(v2Result.summary).toContain("Remote compaction preserved provider-native history");

		// Session branch after that V2 compaction: originals + compaction boundary + new turns.
		const ts = (n: number) => new Date(n).toISOString();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: ts(2),
				summary: v2Result.summary,
				firstKeptEntryId: "m1",
				tokensBefore: 100_000,
				preserveData: v2Result.preserveData,
			},
			{
				type: "message",
				id: "m2",
				parentId: "c1",
				timestamp: ts(3),
				message: { role: "user", content: "second turn", timestamp: 3 },
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: ts(4),
				message: { role: "user", content: "third turn", timestamp: 4 },
			},
		];
		const baseSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

		// Remote disabled → the V2 replay is unusable → re-expand the pre-V2 original.
		const reexpanded = prepareCompaction(entries, { ...baseSettings, remoteEnabled: false }, [v2Model]);
		expect(reexpanded).toBeDefined();
		const reexpandedText = JSON.stringify(reexpanded?.messagesToSummarize ?? []);
		expect(reexpandedText).toContain("ORIGINAL ALPHA port 4242");

		// Remote + V2 still enabled, same provider → reuse the replay, don't re-summarize originals.
		const reused = prepareCompaction(entries, { ...baseSettings, remoteStreamingV2Enabled: true }, [v2Model]);
		expect(reused).toBeDefined();
		const reusedText = JSON.stringify(reused?.messagesToSummarize ?? []);
		expect(reusedText).not.toContain("ORIGINAL ALPHA port 4242");
	});

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
