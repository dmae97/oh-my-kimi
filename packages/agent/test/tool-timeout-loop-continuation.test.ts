import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * A tool timeout must not end the run before the model can react to it.
 *
 * The loop stops a run when a timed-out tool's real promise has not settled,
 * on the theory that an uncooperative tool may still be mutating the workspace.
 * The check runs immediately after the timeout fires, though — the very moment
 * the child abort was signalled — so a tool that honours its `AbortSignal`
 * promptly is indistinguishable from one that ignores it, and every timeout
 * ends the run.
 *
 * The observable cost: the conversation's last message is the timeout result
 * itself. The model never sees it, so it cannot retry with a longer timeout or
 * choose another route, even though the runtime classifies the termination
 * `retryable` and generates advice telling it to do exactly that. A real
 * Terminal-Bench task (`caffe-cifar-10`) died this way, mid-download, with 15
 * minutes of its 20-minute budget unused.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
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
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
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

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const EMPTY_TOOL_PARAMETERS = Type.Object({});
type TimeoutTestTool = AgentTool<typeof EMPTY_TOOL_PARAMETERS, never>;

/** A tool that hangs until aborted, then settles promptly — the cooperative case. */
function cooperativeHangingTool(): TimeoutTestTool {
	return {
		name: "slow",
		label: "slow",
		description: "hangs until aborted",
		parameters: EMPTY_TOOL_PARAMETERS,
		execute: (_id, _args, signal) =>
			new Promise((_resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	};
}

/**
 * A tool that hangs until aborted and then needs a few turns of the event loop
 * to tear down — the shape of every process-backed tool. `bash` kills the
 * process tree on abort and waits for the child to actually exit, so its
 * promise cannot settle in the same tick the abort is raised.
 */
function processLikeHangingTool(teardownMs: number): TimeoutTestTool {
	return {
		name: "slow",
		label: "slow",
		description: "hangs until aborted, then tears down asynchronously",
		parameters: EMPTY_TOOL_PARAMETERS,
		execute: (_id, _args, signal) =>
			new Promise((_resolve, reject) => {
				const teardown = () => setTimeout(() => reject(new Error("aborted")), teardownMs);
				if (signal?.aborted) {
					teardown();
					return;
				}
				signal?.addEventListener("abort", teardown, { once: true });
			}),
	};
}

/** A tool that ignores its abort signal entirely and never settles. */
function uncooperativeTool(): TimeoutTestTool {
	return {
		name: "slow",
		label: "slow",
		description: "never settles",
		parameters: EMPTY_TOOL_PARAMETERS,
		execute: () => new Promise(() => {}),
	};
}

/** Drive one tool call that will time out, then let the model answer normally. */
async function runUntilSettled(
	tool: TimeoutTestTool = cooperativeHangingTool(),
	scheduler?: AgentLoopConfig["toolScheduler"],
): Promise<{
	events: AgentEvent[];
	messages: AgentMessage[];
}> {
	let call = 0;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		call += 1;
		const message =
			call === 1
				? assistantMessage([{ type: "toolCall", id: "call-1", name: "slow", arguments: {} }], "toolUse")
				: assistantMessage([{ type: "text", text: "Retrying with a longer bound." }], "stop");
		queueMicrotask(() => stream.push({ type: "done", reason: call === 1 ? "toolUse" : "stop", message }));
		return stream;
	};

	const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		toolTimeoutMs: 15,
		...(scheduler ? { toolScheduler: scheduler } : {}),
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([userMessage("go")], context, config, undefined, streamFn);
	for await (const event of stream) events.push(event);
	return { events, messages: await stream.result() };
}

describe("tool timeout loop continuation", () => {
	it("hands the timeout result back to the model instead of ending the run on it", async () => {
		const { messages } = await runUntilSettled();
		const last = messages[messages.length - 1];
		expect(last?.role).not.toBe("toolResult");
	});

	it("gives the model a turn after the timeout", async () => {
		const { messages } = await runUntilSettled();
		const timeoutIndex = messages.findIndex((m) => m.role === "toolResult");
		expect(timeoutIndex).toBeGreaterThanOrEqual(0);
		const after = messages.slice(timeoutIndex + 1);
		expect(after.some((m) => m.role === "assistant")).toBe(true);
	});

	it("still records the timeout as a tool result the model can read", async () => {
		const { messages } = await runUntilSettled();
		const toolResult = messages.find((m) => m.role === "toolResult");
		const text = (toolResult?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(" ");
		expect(text).toMatch(/timed out/i);
	});

	// Settling synchronously inside the abort listener is not something a real
	// tool can do. `bash` signals a process-tree kill and waits for the child to
	// exit, which costs at least a turn of the event loop — and the run must
	// survive that just as it survives an instant teardown.
	it("continues for a tool that tears down asynchronously after abort", async () => {
		const { messages } = await runUntilSettled(processLikeHangingTool(5));
		const timeoutIndex = messages.findIndex((m) => m.role === "toolResult");
		const after = messages.slice(timeoutIndex + 1);
		expect(after.some((m) => m.role === "assistant")).toBe(true);
	});

	it("does not end the run on an asynchronous teardown", async () => {
		const { messages } = await runUntilSettled(processLikeHangingTool(5));
		expect(messages[messages.length - 1]?.role).not.toBe("toolResult");
	});
});

/**
 * The DAG scheduler is what coding-agent actually runs (`dag-v2` by default),
 * and it is the path that stops a run when a timed-out tool looks unsettled.
 * The distinction it is trying to draw — cooperative teardown versus a tool
 * that ignores its abort — is only meaningful if a cooperative tool is given
 * long enough to finish tearing down.
 */
describe("tool timeout under the DAG scheduler", () => {
	it("uses the safe DAG timeout guard by default", async () => {
		const { messages } = await runUntilSettled(uncooperativeTool());
		expect(messages[messages.length - 1]?.role).toBe("toolResult");
	});

	it("keeps the unsettled-timeout guard in the waves rollback", async () => {
		const { messages } = await runUntilSettled(uncooperativeTool(), "waves-v1");
		expect(messages[messages.length - 1]?.role).toBe("toolResult");
	});

	it("continues when the tool tears down promptly", async () => {
		const { messages } = await runUntilSettled(processLikeHangingTool(0), "dag-v2");
		expect(messages[messages.length - 1]?.role).not.toBe("toolResult");
	});

	it("continues when teardown costs a few milliseconds", async () => {
		const { messages } = await runUntilSettled(processLikeHangingTool(25), "dag-v2");
		expect(messages[messages.length - 1]?.role).not.toBe("toolResult");
	});

	it("gives the model a turn to react to the timeout", async () => {
		const { messages } = await runUntilSettled(processLikeHangingTool(25), "dag-v2");
		const timeoutIndex = messages.findIndex((m) => m.role === "toolResult");
		expect(messages.slice(timeoutIndex + 1).some((m) => m.role === "assistant")).toBe(true);
	});

	// The safety property this check exists for: a tool still running after the
	// grace window may still be writing, so the run must not continue past it.
	it("still stops the run for a tool that never settles", async () => {
		const { messages } = await runUntilSettled(uncooperativeTool(), "dag-v2");
		expect(messages[messages.length - 1]?.role).toBe("toolResult");
	});
});
