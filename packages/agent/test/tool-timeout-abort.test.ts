import { describe, expect, it } from "vitest";
import { runToolCallWithTimeout, type ToolLateSettlement } from "../src/tool-timeout.ts";
import type { AgentToolResult } from "../src/types.ts";

const TIMEOUT_ENVELOPE_20MS = {
	omk: {
		schema: "tool-result/v2",
		synthetic: true,
		disposition: "timeout",
		reason: 'Tool "echo" timed out after 20ms',
		timeoutMs: 20,
		executionStarted: true,
	},
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function errorResult(error: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
}

async function flushMicrotasks(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function baseOptions(overrides: Partial<Parameters<typeof runToolCallWithTimeout>[0]>) {
	return {
		toolCallId: "t1",
		toolName: "echo",
		timeoutMs: 20,
		signal: undefined,
		start: () => new Promise<AgentToolResult<unknown>>(() => {}),
		emitUpdate: () => {},
		emitLateSettlement: () => {},
		toErrorResult: errorResult,
		...overrides,
	} satisfies Parameters<typeof runToolCallWithTimeout>[0];
}

describe("runToolCallWithTimeout abort and terminal policies", () => {
	it("commits an aborted result when the parent aborts an in-flight signal-ignoring call", async () => {
		const controller = new AbortController();
		const tool = deferred<AgentToolResult<unknown>>(); // ignores the child signal, never settles
		const lateEvents: ToolLateSettlement[] = [];
		// Large timeout so only the parent abort can settle the race.
		const promise = runToolCallWithTimeout(
			baseOptions({
				timeoutMs: 10_000,
				signal: controller.signal,
				start: () => tool.promise,
				emitLateSettlement: (settlement) => void lateEvents.push(settlement),
			}),
		);
		controller.abort();
		const outcome = await promise;

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(lateEvents).toEqual([]);

		// A late settlement after abort is still audited with the aborted disposition.
		tool.resolve({ content: [{ type: "text", text: "late" }], details: {} });
		await flushMicrotasks();
		expect(lateEvents).toEqual([{ toolCallId: "t1", toolName: "echo", disposition: "aborted", outcome: "resolved" }]);
	});

	it("still races parent abort when the timeout is disabled", async () => {
		const controller = new AbortController();
		const tool = deferred<AgentToolResult<unknown>>();
		const lateEvents: ToolLateSettlement[] = [];
		const promise = runToolCallWithTimeout(
			baseOptions({
				timeoutMs: 0,
				signal: controller.signal,
				start: () => tool.promise,
				emitLateSettlement: (settlement) => void lateEvents.push(settlement),
			}),
		);

		// A disabled timeout must not become an immediate 0ms timeout.
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const outcome = await promise;

		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		tool.resolve({ content: [{ type: "text", text: "late" }], details: {} });
		await flushMicrotasks();
		expect(lateEvents).toEqual([{ toolCallId: "t1", toolName: "echo", disposition: "aborted", outcome: "resolved" }]);
	});

	it("keeps the timeout disposition when the child abort makes the tool reject promptly", async () => {
		// Reason ordering: the timer resolves the timeout cause before aborting the
		// child, so a tool that rejects on its signal cannot flip the disposition.
		const outcome = await runToolCallWithTimeout(
			baseOptions({
				timeoutMs: 20,
				start: (childSignal) =>
					new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
						childSignal.addEventListener("abort", () => reject(new Error("aborted by signal")), {
							once: true,
						});
					}),
			}),
		);

		expect(outcome.isError).toBe(true);
		expect(outcome.result.details).toEqual(TIMEOUT_ENVELOPE_20MS);
	});

	it("stamps the aborted envelope with executionStarted true for an in-flight abort", async () => {
		const controller = new AbortController();
		const tool = deferred<AgentToolResult<unknown>>();
		const promise = runToolCallWithTimeout(
			baseOptions({ timeoutMs: 0, signal: controller.signal, start: () => tool.promise }),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const outcome = await promise;

		expect(outcome.result.details).toEqual({
			omk: {
				schema: "tool-result/v2",
				synthetic: true,
				disposition: "aborted",
				reason: "Operation aborted",
				executionStarted: true,
			},
		});
	});

	it("stamps the aborted envelope with executionStarted false when the parent aborted pre-start", async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await runToolCallWithTimeout(
			baseOptions({ signal: controller.signal, start: () => deferred<AgentToolResult<unknown>>().promise }),
		);

		expect(outcome.isError).toBe(true);
		expect(outcome.result.details).toEqual({
			omk: {
				schema: "tool-result/v2",
				synthetic: true,
				disposition: "aborted",
				reason: "Operation aborted",
				executionStarted: false,
			},
		});
	});

	it("suppresses the late-settlement audit when the policy is ignore, and keeps it by default", async () => {
		const tool = deferred<AgentToolResult<unknown>>();
		const lateEvents: ToolLateSettlement[] = [];
		await runToolCallWithTimeout(
			baseOptions({
				timeoutMs: 20,
				lateSettlement: "ignore",
				start: () => tool.promise,
				emitLateSettlement: (settlement) => void lateEvents.push(settlement),
			}),
		);
		tool.resolve({ content: [{ type: "text", text: "late" }], details: {} });
		await flushMicrotasks();
		expect(lateEvents).toEqual([]);
	});
});
