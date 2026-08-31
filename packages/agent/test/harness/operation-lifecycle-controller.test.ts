import { describe, expect, it } from "vitest";
import { type OperationLease, OperationLifecycleController } from "../../src/harness/operation-lifecycle-controller.ts";
import {
	type HarnessLifecycleDependencies,
	HarnessLifecycleViolation,
} from "../../src/harness/operation-lifecycle-types.ts";

function deferred<T = void>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function makeController(): {
	controller: OperationLifecycleController;
	now: () => number;
	advance: (ms: number) => void;
} {
	let idCounter = 0;
	let clock = 1_000;
	const deps: HarnessLifecycleDependencies = {
		createOperationId: () => `op-${++idCounter}`,
		now: () => clock,
	};
	return {
		controller: new OperationLifecycleController(deps),
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const COMPLETED = { status: "completed" } as const;
const NOOP_FINALIZE = async (): Promise<void> => undefined;

describe("OperationLifecycleController begin and settle", () => {
	it("begins one operation and rejects a concurrent begin with busy", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		expect(lease.operation).toMatchObject({ operationId: "op-1", sequence: 1, kind: "prompt", startedAtMs: 1_000 });
		expect(() => controller.begin("skill")).toThrowError(expect.objectContaining({ code: "busy" }));
		await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
		const second = controller.begin("skill");
		expect(second.operation.sequence).toBe(2);
		await controller.settle(second, COMPLETED, NOOP_FINALIZE);
	});

	it("settles exactly once and resolves the lease with the recorded outcome", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const outcome = await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
		expect(outcome).toEqual(COMPLETED);
		await expect(lease.settled).resolves.toEqual(COMPLETED);
		await expect(controller.settle(lease, COMPLETED, NOOP_FINALIZE)).rejects.toMatchObject({ code: "invalid_state" });
		expect(controller.getSnapshot()).toEqual({ tag: "idle", lastSequence: 1 });
	});

	it("keeps settle idempotent against a racing second settle while settling", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const gate = deferred();
		const first = controller.settle(lease, COMPLETED, () => gate.promise);
		await expect(controller.settle(lease, COMPLETED, NOOP_FINALIZE)).rejects.toMatchObject({ code: "invalid_state" });
		gate.resolve();
		await first;
		await expect(lease.settled).resolves.toEqual(COMPLETED);
	});

	it("runs the finalizer inside the settling barrier before releasing state", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const gate = deferred();
		const order: string[] = [];
		const settling = controller.settle(lease, COMPLETED, async () => {
			order.push(`finalize:${controller.getSnapshot().tag}`);
			await gate.promise;
		});
		await Promise.resolve();
		expect(controller.getSnapshot().tag).toBe("settling");
		expect(controller.getCurrentOperation()?.operationId).toBe("op-1");
		gate.resolve();
		await settling;
		order.push(`after:${controller.getSnapshot().tag}`);
		expect(order).toEqual(["finalize:settling", "after:idle"]);
	});

	it("rejects settle when the finalizer fails but still releases state and resolves the lease", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const flushFailure = new Error("session flush failed");
		const idleWait = controller.waitForIdle();
		await expect(
			controller.settle(lease, { status: "failed", code: "session", message: "flush failed" }, async () => {
				throw flushFailure;
			}),
		).rejects.toBe(flushFailure);
		expect(controller.getSnapshot()).toEqual({ tag: "idle", lastSequence: 1 });
		await expect(lease.settled).resolves.toEqual({ status: "failed", code: "session", message: "flush failed" });
		await idleWait;
	});
});

describe("OperationLifecycleController lease discipline", () => {
	it("rejects stale lease mutation after the operation settled", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
		expect(() => controller.setStage(lease, "save_point")).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
		expect(() => controller.beginAttempt(lease, "initial")).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
		expect(() => controller.getAttemptSummaries(lease)).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
	});

	it("rejects a prior lease mutating the next operation", async () => {
		const { controller } = makeController();
		const first = controller.begin("prompt");
		await controller.settle(first, COMPLETED, NOOP_FINALIZE);
		const second = controller.begin("skill");
		expect(() => controller.setStage(first, "recovering_overflow")).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
		expect(controller.getCurrentOperation()?.operationId).toBe("op-2");
		expect(controller.getSnapshot()).toMatchObject({ tag: "active", stage: "preparing" });
		await controller.settle(second, COMPLETED, NOOP_FINALIZE);
	});

	it("preserves the reducer violation as the error cause", () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		try {
			controller.setStage(lease, "structural_running");
			expect.unreachable("setStage must reject");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_state" });
			expect((error as { cause?: unknown }).cause).toBeInstanceOf(HarnessLifecycleViolation);
			expect((error as { cause?: HarnessLifecycleViolation }).cause?.code).toBe("invalid_transition");
		}
	});
});

describe("OperationLifecycleController attempts", () => {
	it("derives attempt ids and records bounded summaries with clock readings", async () => {
		const { controller, advance } = makeController();
		const lease = controller.begin("prompt");
		const initial = controller.beginAttempt(lease, "initial");
		expect(initial.attempt).toMatchObject({ attemptId: "op-1:a0", index: 0, reason: "initial" });
		expect(initial.signal).toBe(lease.signal);
		advance(50);
		controller.finishAttempt(lease, initial, "overflow");
		controller.setStage(lease, "recovering_overflow");
		const recovery = controller.beginAttempt(lease, "context_overflow_recovery");
		expect(recovery.attempt).toMatchObject({ attemptId: "op-1:a1", index: 1, reason: "context_overflow_recovery" });
		advance(25);
		controller.finishAttempt(lease, recovery, "completed");
		const summaries = controller.getAttemptSummaries(lease);
		expect(summaries).toEqual([
			{
				attemptId: "op-1:a0",
				index: 0,
				reason: "initial",
				outcome: "overflow",
				startedAtMs: 1_000,
				finishedAtMs: 1_050,
			},
			{
				attemptId: "op-1:a1",
				index: 1,
				reason: "context_overflow_recovery",
				outcome: "completed",
				startedAtMs: 1_050,
				finishedAtMs: 1_075,
			},
		]);
		await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
	});

	it("rejects finishing an attempt with a stale attempt lease", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const initial = controller.beginAttempt(lease, "initial");
		controller.finishAttempt(lease, initial, "completed");
		expect(() => controller.finishAttempt(lease, initial, "completed")).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
		await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
	});
});

describe("OperationLifecycleController abort capture", () => {
	it("delivers the signal to the captured operation and flags the snapshot", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const capture = controller.requestAbort();
		expect(capture.target).toBe(lease);
		expect(capture.signalDelivered).toBe(true);
		expect(lease.signal.aborted).toBe(true);
		expect(controller.getSnapshot()).toMatchObject({ tag: "active", abortRequested: true });
		await controller.settle(lease, { status: "aborted" }, NOOP_FINALIZE);
		await expect(lease.settled).resolves.toEqual({ status: "aborted" });
	});

	it("captures no target while idle", () => {
		const { controller } = makeController();
		expect(controller.requestAbort()).toEqual({ signalDelivered: false });
	});

	it("does not deliver a signal while settling but still captures the target", async () => {
		const { controller } = makeController();
		const lease = controller.begin("prompt");
		const gate = deferred();
		const settling = controller.settle(lease, COMPLETED, () => gate.promise);
		await Promise.resolve();
		const capture = controller.requestAbort();
		expect(capture.target).toBe(lease);
		expect(capture.signalDelivered).toBe(false);
		expect(lease.signal.aborted).toBe(false);
		gate.resolve();
		await settling;
	});

	it("aborts only the captured operation, never a later one", async () => {
		const { controller } = makeController();
		const first = controller.begin("prompt");
		controller.requestAbort();
		expect(first.signal.aborted).toBe(true);
		await controller.settle(first, { status: "aborted" }, NOOP_FINALIZE);
		const second = controller.begin("prompt");
		expect(second.signal.aborted).toBe(false);
		expect(controller.getSnapshot()).toMatchObject({ tag: "active", abortRequested: false });
		await controller.settle(second, COMPLETED, NOOP_FINALIZE);
	});
});

describe("OperationLifecycleController waitForIdle", () => {
	it("resolves immediately when idle and after settlement when active", async () => {
		const { controller } = makeController();
		await controller.waitForIdle();
		const lease = controller.begin("prompt");
		const gate = deferred();
		let idleObserved = false;
		const waiting = controller.waitForIdle().then(() => {
			idleObserved = true;
		});
		const settling = controller.settle(lease, COMPLETED, () => gate.promise);
		await Promise.resolve();
		expect(idleObserved).toBe(false);
		gate.resolve();
		await settling;
		await waiting;
		expect(idleObserved).toBe(true);
	});
});

describe("OperationLifecycleController operation identity", () => {
	it("allocates ids and timestamps through injected dependencies", async () => {
		const { controller } = makeController();
		const lease = controller.begin("manual_compaction");
		expect(lease.operation).toMatchObject({ operationId: "op-1", startedAtMs: 1_000 });
		await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
	});

	it("exposes the current operation only while active or settling", async () => {
		const { controller } = makeController();
		expect(controller.getCurrentOperation()).toBeUndefined();
		const lease: OperationLease = controller.begin("prompt");
		expect(controller.getCurrentOperation()?.operationId).toBe("op-1");
		await controller.settle(lease, COMPLETED, NOOP_FINALIZE);
		expect(controller.getCurrentOperation()).toBeUndefined();
	});
});
