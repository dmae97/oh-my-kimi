import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
} from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type {
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	BeforeToolCallResult,
	ToolResourceClaims,
} from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected assistant event");
			},
		);
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function isModelMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function streamFor(calls: readonly AgentToolCall[]) {
	let request = 0;
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const firstCall = request++ === 0;
			const message = firstCall
				? assistant([...calls], "toolUse")
				: assistant([{ type: "text", text: "done" }], "stop");
			stream.push({ type: "done", reason: firstCall ? "toolUse" : "stop", message });
		});
		return stream;
	};
}

async function runBatch(
	calls: readonly AgentToolCall[],
	tools: NonNullable<AgentContext["tools"]>,
	config: Omit<Partial<AgentLoopConfig>, "model" | "convertToLlm"> = {},
	signal?: AbortSignal,
): Promise<{ messages: AgentMessage[]; events: AgentEvent[] }> {
	const events: AgentEvent[] = [];
	const messages = await runAgentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		{ systemPrompt: "", messages: [], tools },
		{ ...config, model, convertToLlm: (items) => items.filter(isModelMessage) },
		(event) => {
			events.push(event);
		},
		signal,
		streamFor(calls),
	);
	return { messages, events };
}

function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => undefined);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let settle: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return {
		promise,
		resolve(value) {
			if (settle === undefined) throw new Error("Deferred was not initialized");
			settle(value);
		},
	};
}

function results(messages: readonly AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function lifecycle(events: readonly AgentEvent[], type: "tool_execution_start" | "tool_execution_end"): string[] {
	return events.flatMap((event) => (event.type === type ? [event.toolCallId] : []));
}

describe("tool execution abort boundary", () => {
	it.each([
		{ phase: "claim", scheduler: "dag-v2" },
		{ phase: "before", scheduler: "dag-v2" },
		{ phase: "before", scheduler: "waves-v1" },
		{ phase: "after", scheduler: "dag-v2" },
	] as const)(
		"bounds a never-settling $phase hook under $scheduler and closes the call once",
		async ({ phase, scheduler }) => {
			// Given: one emitted call blocked forever in the selected extension boundary.
			const schema = Type.Object({ path: Type.String() });
			const reached = deferred<void>();
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { path: string }> = {
				name: "extension",
				label: "Extension",
				description: "Adversarial extension",
				parameters: schema,
				resourceClaims() {
					if (phase === "claim") {
						reached.resolve(undefined);
						return neverSettles<ToolResourceClaims>();
					}
					return [{ kind: "global", key: "extension", access: "write" }];
				},
				async execute(_id, params) {
					return { content: [{ type: "text", text: params.path }], details: params };
				},
			};
			const config = {
				toolScheduler: scheduler,
				beforeToolCall: async (): Promise<BeforeToolCallResult | undefined> => {
					if (phase !== "before") return undefined;
					reached.resolve(undefined);
					return neverSettles<BeforeToolCallResult | undefined>();
				},
				afterToolCall: async (): Promise<AfterToolCallResult | undefined> => {
					if (phase !== "after") return undefined;
					reached.resolve(undefined);
					return neverSettles<AfterToolCallResult | undefined>();
				},
			};
			const running = runBatch(
				[{ type: "toolCall", id: "call-1", name: "extension", arguments: { path: "a" } }],
				[tool],
				config,
				controller.signal,
			);

			// When: the parent aborts after the adversarial boundary is entered.
			await reached.promise;
			controller.abort();
			const outcome = await Promise.race([
				running.then((value) => ({ kind: "settled" as const, value })),
				new Promise<{ kind: "pending" }>((resolve) => setImmediate(() => resolve({ kind: "pending" }))),
			]);

			// Then: abort wins promptly, with one immutable terminal and balanced execution lifecycle.
			expect(outcome.kind).toBe("settled");
			if (outcome.kind === "pending") return;
			const terminal = results(outcome.value.messages);
			expect(terminal).toHaveLength(1);
			expect(terminal[0]).toMatchObject({
				toolCallId: "call-1",
				isError: true,
				details: { omk: { disposition: "aborted", synthetic: true } },
			});
			const expectedLifecycle = phase === "after" ? ["call-1"] : [];
			expect(lifecycle(outcome.value.events, "tool_execution_start")).toEqual(expectedLifecycle);
			expect(lifecycle(outcome.value.events, "tool_execution_end")).toEqual(expectedLifecycle);
		},
	);

	it("does not start a hook-created sublevel after an unsettled timeout or let afterToolCall rewrite it", async () => {
		// Given: raw-disjoint writes retargeted by a hook, with the first execution ignoring its timeout signal.
		const schema = Type.Object({ path: Type.String() });
		const executed: string[] = [];
		let afterCalls = 0;
		const tool: AgentTool<typeof schema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write a path",
			parameters: schema,
			timeoutMs: 10,
			execute(id, params) {
				executed.push(id);
				return id === "first"
					? neverSettles()
					: Promise.resolve({ content: [{ type: "text", text: params.path }], details: params });
			},
		};

		// When: final claims create two sublevels and the first commits a timeout.
		const outcome = await runBatch(
			[
				{ type: "toolCall", id: "first", name: "write", arguments: { path: "a" } },
				{ type: "toolCall", id: "queued", name: "write", arguments: { path: "b" } },
			],
			[tool],
			{
				toolScheduler: "dag-v2",
				beforeToolCall: async ({ args, toolCall }) => {
					Reflect.set(toolCall, "name", "read");
					if (typeof args === "object" && args !== null && "path" in args) args.path = "same";
					return undefined;
				},
				afterToolCall: async () => {
					afterCalls++;
					return { content: [{ type: "text", text: "forged" }], isError: false };
				},
			},
		);

		// Then: only the real sublevel has balanced lifecycle, and timeout/skipped terminals stay errors.
		const terminal = results(outcome.messages);
		expect(executed).toEqual(["first"]);
		expect(lifecycle(outcome.events, "tool_execution_start")).toEqual(["first"]);
		expect(lifecycle(outcome.events, "tool_execution_end")).toEqual(["first"]);
		expect(terminal.map((result) => [result.toolCallId, result.isError])).toEqual([
			["first", true],
			["queued", true],
		]);
		expect(terminal.map((result) => result.details)).toMatchObject([
			{ omk: { disposition: "timeout", synthetic: true, executionStarted: true } },
			{ omk: { disposition: "skipped", synthetic: true, executionStarted: false } },
		]);
		expect(afterCalls).toBe(0);
	});
});
