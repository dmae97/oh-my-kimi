import { describe, expect, it } from "bun:test";
import {
	EVAL_TIMEOUT_PAUSE_OP,
	EVAL_TIMEOUT_RESUME_OP,
	isEvalTimeoutControlEvent,
	withBridgeTimeoutPause,
} from "../bridge-timeout";
import { executeWithKernelBase, type GenericKernel } from "../executor-base";
import type { JsStatusEvent } from "../js/shared/types";
import type { KernelDisplayOutput } from "../py/display";

describe("withBridgeTimeoutPause", () => {
	it("emits one pause before the operation and one resume after it settles", async () => {
		const events: JsStatusEvent[] = [];

		const value = await withBridgeTimeoutPause(
			event => events.push(event),
			async () => {
				await Bun.sleep(80);
				return "done";
			},
			{ deferExternalAbort: true },
		);

		expect(value).toBe("done");
		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
		expect(events.every(event => event.deferExternalAbort === true)).toBe(true);

		const settledCount = events.length;
		await Bun.sleep(40);
		expect(events.length).toBe(settledCount);
	});

	it("resumes timeout accounting even when the operation throws", async () => {
		const events: JsStatusEvent[] = [];

		await expect(
			withBridgeTimeoutPause(
				event => events.push(event),
				async () => {
					await Bun.sleep(20);
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");

		expect(events.map(event => event.op)).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
	});

	it("runs the operation without emitting when no status sink is wired", async () => {
		let ran = 0;

		const value = await withBridgeTimeoutPause(undefined, async () => {
			ran++;
			await Bun.sleep(20);
			return 42;
		});

		expect(value).toBe(42);
		expect(ran).toBe(1);
	});

	it("identifies timeout-control events as non-renderable status", () => {
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_PAUSE_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_RESUME_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: "agent", id: "subagent-1" })).toBe(false);
	});
});

class TestCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
		this.timedOut = timedOut;
	}
}

it("defers external aborts until an in-flight agent bridge call resumes", async () => {
	const abortController = new AbortController();
	const entered = Promise.withResolvers<void>();
	const triggerAbort = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await triggerAbort.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			abortController.abort(new Error("external interrupt"));
			observed.resolve(options.signal?.aborted ?? false);
			await release.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true },
			} satisfies KernelDisplayOutput);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "agent('slow')",
		options: { signal: abortController.signal },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	triggerAbort.resolve();
	expect(await observed.promise).toBe(false);
	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
	expect(result.exitCode).toBeUndefined();
});

it("does not defer external aborts for a completion bridge call", async () => {
	const abortController = new AbortController();
	const entered = Promise.withResolvers<void>();
	const triggerAbort = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<void>();
	const kernel: GenericKernel<Record<string, string | null>> = {
		async execute(_code, options) {
			entered.resolve();
			await triggerAbort.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_PAUSE_OP },
			} satisfies KernelDisplayOutput);
			abortController.abort(new Error("external interrupt"));
			observed.resolve(options.signal?.aborted ?? false);
			await release.promise;
			options.onDisplay({
				type: "status",
				event: { op: EVAL_TIMEOUT_RESUME_OP },
			} satisfies KernelDisplayOutput);
			return { status: "ok", cancelled: false, timedOut: false };
		},
	};

	const resultPromise = executeWithKernelBase({
		kernel,
		code: "completion('slow')",
		options: { signal: abortController.signal },
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => ({}),
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => "timed out",
	});

	await entered.promise;
	triggerAbort.resolve();
	expect(await observed.promise).toBe(true);
	release.resolve();
	const result = await resultPromise;
	expect(result.cancelled).toBe(true);
	expect(result.exitCode).toBeUndefined();
});
