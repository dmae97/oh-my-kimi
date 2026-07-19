import { describe, expect, it, vi } from "vitest";
import {
	resolveToolExecutionPolicy,
	resolveToolTimeoutMs,
	runToolCallWithTimeout,
	type ToolLateSettlement,
} from "../src/tool-timeout.ts";
import { type AgentToolResult, createToolResultEnvelope, isToolResultEnvelope } from "../src/types.ts";

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

function errorResult(error: unknown): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: {},
	};
}

async function flushMicrotasks(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
}

/** Options preset with inert sinks; individual tests override what they assert on. */
function baseOptions(overrides: Partial<Parameters<typeof runToolCallWithTimeout>[0]>) {
	return {
		toolCallId: "t1",
		toolName: "echo",
		timeoutMs: 20,
		signal: undefined,
		start: () => new Promise<AgentToolResult<any>>(() => {}),
		emitUpdate: () => {},
		emitLateSettlement: () => {},
		toErrorResult: errorResult,
		...overrides,
	} satisfies Parameters<typeof runToolCallWithTimeout>[0];
}

describe("resolveToolTimeoutMs", () => {
	it("applies per-tool > per-name > global precedence and disables on absent/zero", () => {
		// Per-tool wins over per-name and global.
		expect(resolveToolTimeoutMs({ timeoutMs: 10 }, { toolTimeouts: { echo: 20 }, toolTimeoutMs: 30 }, "echo")).toBe(
			10,
		);
		// Per-name wins over global when per-tool is absent.
		expect(resolveToolTimeoutMs({}, { toolTimeouts: { echo: 20 }, toolTimeoutMs: 30 }, "echo")).toBe(20);
		// Global applies when neither per-tool nor per-name is present.
		expect(resolveToolTimeoutMs({}, { toolTimeoutMs: 30 }, "echo")).toBe(30);
		// Per-name only matches its own tool name.
		expect(resolveToolTimeoutMs({}, { toolTimeouts: { other: 20 }, toolTimeoutMs: 30 }, "echo")).toBe(30);
		// Nothing configured -> disabled.
		expect(resolveToolTimeoutMs({}, {}, "echo")).toBe(0);
		// Explicit per-tool 0 disables even when a global default is set.
		expect(resolveToolTimeoutMs({ timeoutMs: 0 }, { toolTimeoutMs: 30 }, "echo")).toBe(0);
		// Non-positive / non-finite values are treated as disabled.
		expect(resolveToolTimeoutMs({ timeoutMs: -5 }, {}, "echo")).toBe(0);
		expect(resolveToolTimeoutMs({ timeoutMs: Number.NaN }, {}, "echo")).toBe(0);
		expect(resolveToolTimeoutMs({ timeoutMs: Number.POSITIVE_INFINITY }, {}, "echo")).toBe(0);
	});
});

describe("runToolCallWithTimeout", () => {
	it("commits an immediate immutable timeout result for a signal-ignoring tool", async () => {
		const tool = deferred<AgentToolResult<any>>(); // ignores the signal, never settles
		const lateEvents: ToolLateSettlement[] = [];
		const outcome = await runToolCallWithTimeout(
			baseOptions({
				timeoutMs: 20,
				start: () => tool.promise,
				emitLateSettlement: (settlement) => void lateEvents.push(settlement),
			}),
		);

		expect(outcome.isError).toBe(true);
		// Human-readable content, model-facing; the disposition envelope lives only in details.
		expect(outcome.result.content).toEqual([
			{ type: "text", text: 'Tool "echo" timed out after 20ms and was terminated.' },
		]);
		expect(outcome.result.details).toEqual(TIMEOUT_ENVELOPE_20MS);
		// The committed terminal result is immutable.
		expect(Object.isFrozen(outcome.result)).toBe(true);
		expect(Object.isFrozen(outcome.result.details)).toBe(true);
		// No late settlement while the real promise is still pending.
		expect(lateEvents).toEqual([]);
	});

	it("observes a late resolve exactly once and never mutates the committed result", async () => {
		const tool = deferred<AgentToolResult<any>>();
		const lateEvents: ToolLateSettlement[] = [];
		const outcome = await runToolCallWithTimeout(
			baseOptions({
				timeoutMs: 20,
				start: () => tool.promise,
				emitLateSettlement: (settlement) => void lateEvents.push(settlement),
			}),
		);
		const committedContent = outcome.result.content;

		// The real tool resolves long after the timeout already committed.
		tool.resolve({ content: [{ type: "text", text: "late success" }], details: { late: true } });
		await flushMicrotasks();

		expect(lateEvents).toEqual([{ toolCallId: "t1", toolName: "echo", disposition: "timeout", outcome: "resolved" }]);
		// Committed timeout result is unchanged; no second result was produced.
		expect(outcome.result.content).toBe(committedContent);
		expect(outcome.result.details).toEqual(TIMEOUT_ENVELOPE_20MS);

		// Nothing settles a promise twice, so no duplicate late event ever fires.
		await flushMicrotasks();
		expect(lateEvents).toHaveLength(1);
	});

	it("observes a late reject once without an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const tool = deferred<AgentToolResult<any>>();
			const lateEvents: ToolLateSettlement[] = [];
			await runToolCallWithTimeout(
				baseOptions({
					timeoutMs: 20,
					start: () => tool.promise,
					emitLateSettlement: (settlement) => void lateEvents.push(settlement),
				}),
			);

			tool.reject(new Error("late failure"));
			// Give Node a real macrotask to surface any unhandled rejection.
			await flushMicrotasks();
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(lateEvents).toEqual([
				{ toolCallId: "t1", toolName: "echo", disposition: "timeout", outcome: "rejected" },
			]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("returns the real result and clears the timer on normal completion", async () => {
		vi.useFakeTimers();
		try {
			const lateEvents: ToolLateSettlement[] = [];
			const normalResult: AgentToolResult<{ value: number }> = {
				content: [{ type: "text", text: "ok" }],
				details: { value: 1 },
			};
			const outcome = await runToolCallWithTimeout(
				baseOptions({
					timeoutMs: 10_000,
					start: async () => normalResult,
					emitLateSettlement: (settlement) => void lateEvents.push(settlement),
				}),
			);

			expect(outcome.isError).toBe(false);
			expect(outcome.result).toBe(normalResult);
			// The timeout timer was disposed on the real-completion outcome.
			expect(vi.getTimerCount()).toBe(0);

			// Advancing well past the (cleared) timeout does nothing.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(lateEvents).toEqual([]);
			expect(outcome.result).toBe(normalResult);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("tool-result/v2 envelope validation", () => {
	it("rejects synthetic completed and non-started timeout envelopes", () => {
		const syntheticCompleted = {
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "completed",
			executionStarted: true,
		};
		const nonStartedTimeout = {
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "timeout",
			timeoutMs: 20,
			executionStarted: false,
		};

		expect(isToolResultEnvelope(syntheticCompleted)).toBe(false);
		expect(isToolResultEnvelope(nonStartedTimeout)).toBe(false);
		expect(() =>
			createToolResultEnvelope({
				synthetic: true,
				disposition: "completed",
				executionStarted: true,
			}),
		).toThrow(TypeError);
		expect(() =>
			createToolResultEnvelope({
				synthetic: true,
				disposition: "timeout",
				timeoutMs: 20,
				executionStarted: false,
			}),
		).toThrow(TypeError);
	});
});

describe("resolveToolExecutionPolicy", () => {
	it("defaults lateSettlement to audit and honors explicit overrides", () => {
		expect(resolveToolExecutionPolicy(undefined)).toEqual({ lateSettlement: "audit" });
		expect(resolveToolExecutionPolicy({})).toEqual({ lateSettlement: "audit" });
		expect(resolveToolExecutionPolicy({ lateSettlement: "ignore" })).toEqual({ lateSettlement: "ignore" });
		expect(resolveToolExecutionPolicy({ lateSettlement: "audit", timeoutMs: 5 })).toEqual({
			lateSettlement: "audit",
			timeoutMs: 5,
		});
	});
});
