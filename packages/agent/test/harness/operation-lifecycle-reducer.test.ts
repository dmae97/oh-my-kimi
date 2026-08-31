import { describe, expect, it } from "vitest";
import { initialHarnessLifecycleState, reduceHarnessLifecycle } from "../../src/harness/operation-lifecycle-reducer.ts";
import type {
	HarnessAttemptOutcome,
	HarnessAttemptRef,
	HarnessLifecycleCommand,
	HarnessLifecycleState,
	HarnessLifecycleViolation,
	HarnessOperationKind,
	HarnessOperationOutcome,
	HarnessOperationRef,
} from "../../src/harness/operation-lifecycle-types.ts";

let idCounter = 0;
function op(kind: HarnessOperationKind, sequence = 1, id = `op-${++idCounter}`): HarnessOperationRef {
	return { operationId: id, sequence, kind, startedAtMs: 1000 };
}

function attempt(
	operationId: string,
	index: number,
	reason: HarnessAttemptRef["reason"] = "initial",
): HarnessAttemptRef {
	return { operationId, attemptId: `${operationId}:a${index}`, index, reason, startedAtMs: 1100 };
}

const COMPLETED: HarnessOperationOutcome = { status: "completed" };

function apply(state: HarnessLifecycleState, command: HarnessLifecycleCommand): HarnessLifecycleState {
	const next = reduceHarnessLifecycle(state, command);
	if (!next.ok) throw next.error;
	return next.value;
}

function violation(state: HarnessLifecycleState, command: HarnessLifecycleCommand): HarnessLifecycleViolation {
	const next = reduceHarnessLifecycle(state, command);
	if (next.ok) throw new Error(`Expected violation for ${command.type}, got state ${JSON.stringify(next.value)}`);
	return next.error;
}

function activePrompt(): HarnessLifecycleState {
	return apply(initialHarnessLifecycleState(), { type: "begin", operation: op("prompt") });
}

function activePromptRunning(): { state: HarnessLifecycleState; attemptRef: HarnessAttemptRef; opId: string } {
	const begun = activePrompt();
	const opId = begun.tag === "active" ? begun.operation.operationId : "";
	const attemptRef = attempt(opId, 0);
	const state = apply(begun, { type: "attempt_begin", attempt: attemptRef });
	return { state, attemptRef, opId };
}

function activeStructural(kind: HarnessOperationKind = "manual_compaction"): {
	state: HarnessLifecycleState;
	opId: string;
} {
	const begun = apply(initialHarnessLifecycleState(), { type: "begin", operation: op(kind) });
	return { state: begun, opId: begun.tag === "active" ? begun.operation.operationId : "" };
}

function endAttempt(
	state: HarnessLifecycleState,
	attemptRef: HarnessAttemptRef,
	outcome: HarnessAttemptOutcome,
): HarnessLifecycleState {
	return apply(state, { type: "attempt_end", attemptId: attemptRef.attemptId, outcome });
}

describe("reduceHarnessLifecycle legal transitions", () => {
	it("begins from idle into active/preparing", () => {
		const state = activePrompt();
		expect(state).toMatchObject({ tag: "active", stage: "preparing", attempts: [], abortRequested: false });
	});

	it("runs a full prompt operation with overflow recovery in one operation id", () => {
		const { state: running, attemptRef, opId } = activePromptRunning();
		const saved = apply(running, { type: "stage", operationId: opId, stage: "save_point" });
		const resumed = apply(saved, { type: "stage", operationId: opId, stage: "attempt_running" });
		const ended = endAttempt(resumed, attemptRef, "overflow");
		expect(ended).toMatchObject({
			tag: "active",
			stage: "preparing",
			attempt: undefined,
			attempts: [{ outcome: "overflow" }],
		});
		const recovering = apply(ended, { type: "stage", operationId: opId, stage: "recovering_overflow" });
		const recoveryAttempt = attempt(opId, 1, "context_overflow_recovery");
		const reRunning = apply(recovering, { type: "attempt_begin", attempt: recoveryAttempt });
		const reEnded = endAttempt(reRunning, recoveryAttempt, "completed");
		const settling = apply(reEnded, { type: "settle_begin", operationId: opId, outcome: COMPLETED });
		expect(settling).toMatchObject({ tag: "settling", outcome: COMPLETED });
		expect(settling.tag === "settling" && settling.attempts).toHaveLength(2);
		const idle = apply(settling, { type: "settle_finish", operationId: opId });
		expect(idle).toEqual({ tag: "idle", lastSequence: 1 });
	});

	it("runs a structural operation through its commit point", () => {
		const { state, opId } = activeStructural();
		const running = apply(state, { type: "stage", operationId: opId, stage: "structural_running" });
		const committing = apply(running, { type: "stage", operationId: opId, stage: "committing" });
		const settling = apply(committing, { type: "settle_begin", operationId: opId, outcome: COMPLETED });
		expect(apply(settling, { type: "settle_finish", operationId: opId })).toEqual({ tag: "idle", lastSequence: 1 });
	});

	it("records abort requests without changing stage", () => {
		const { state, opId } = activePromptRunning();
		const flagged = apply(state, { type: "abort_request", operationId: opId });
		expect(flagged).toMatchObject({ tag: "active", stage: "attempt_running", abortRequested: true });
	});

	it("settles from any active stage", () => {
		const { state, opId } = activePromptRunning();
		const settling = apply(state, { type: "settle_begin", operationId: opId, outcome: { status: "aborted" } });
		expect(settling).toMatchObject({ tag: "settling", outcome: { status: "aborted" } });
	});
});

describe("reduceHarnessLifecycle violations", () => {
	it("rejects begin while active or settling with busy", () => {
		const active = activePrompt();
		expect(violation(active, { type: "begin", operation: op("skill") }).code).toBe("busy");
		const opId = active.tag === "active" ? active.operation.operationId : "";
		const settling = apply(active, { type: "settle_begin", operationId: opId, outcome: COMPLETED });
		expect(violation(settling, { type: "begin", operation: op("skill") }).code).toBe("busy");
	});

	it("rejects sequence skips on begin", () => {
		const idle = initialHarnessLifecycleState();
		expect(violation(idle, { type: "begin", operation: op("prompt", 2) }).code).toBe("sequence_violation");
		expect(violation(idle, { type: "begin", operation: op("prompt", 0) }).code).toBe("sequence_violation");
	});

	it("rejects attempt_begin from idle", () => {
		const idle = initialHarnessLifecycleState();
		expect(violation(idle, { type: "attempt_begin", attempt: attempt("op-x", 0) }).code).toBe("invalid_transition");
	});

	it("rejects every non-begin command from idle", () => {
		const idle = initialHarnessLifecycleState();
		const commands: HarnessLifecycleCommand[] = [
			{ type: "stage", operationId: "op-x", stage: "save_point" },
			{ type: "attempt_end", attemptId: "op-x:a0", outcome: "completed" },
			{ type: "abort_request", operationId: "op-x" },
			{ type: "settle_begin", operationId: "op-x", outcome: COMPLETED },
			{ type: "settle_finish", operationId: "op-x" },
		];
		for (const command of commands) expect(violation(idle, command).code).toBe("invalid_transition");
	});

	it("rejects stage changes targeting another operation", () => {
		const { state } = activePromptRunning();
		expect(violation(state, { type: "stage", operationId: "op-other", stage: "save_point" }).code).toBe(
			"stale_operation",
		);
	});

	it("rejects new begins while settling and non-finish commands during settling", () => {
		const active = activePrompt();
		const opId = active.tag === "active" ? active.operation.operationId : "";
		const settling = apply(active, { type: "settle_begin", operationId: opId, outcome: COMPLETED });
		const commands: HarnessLifecycleCommand[] = [
			{ type: "stage", operationId: opId, stage: "save_point" },
			{ type: "attempt_begin", attempt: attempt(opId, 0) },
			{ type: "attempt_end", attemptId: `${opId}:a0`, outcome: "completed" },
			{ type: "abort_request", operationId: opId },
			{ type: "settle_begin", operationId: opId, outcome: COMPLETED },
		];
		for (const command of commands) expect(violation(settling, command).code).toBe("invalid_transition");
		expect(violation(settling, { type: "settle_finish", operationId: "op-other" }).code).toBe("stale_operation");
	});

	it("rejects non-increasing and skipped attempt indices", () => {
		const { state, attemptRef, opId } = activePromptRunning();
		const ended = endAttempt(state, attemptRef, "overflow");
		const recovering = apply(ended, { type: "stage", operationId: opId, stage: "recovering_overflow" });
		for (const index of [0, 2]) {
			expect(
				violation(recovering, { type: "attempt_begin", attempt: attempt(opId, index, "context_overflow_recovery") })
					.code,
			).toBe("sequence_violation");
		}
		const next = reduceHarnessLifecycle(recovering, {
			type: "attempt_begin",
			attempt: attempt(opId, 1, "context_overflow_recovery"),
		});
		expect(next.ok).toBe(true);
	});

	it("rejects a second attempt while one is active", () => {
		const { state, opId } = activePromptRunning();
		expect(
			violation(state, { type: "attempt_begin", attempt: attempt(opId, 1, "context_overflow_recovery") }).code,
		).toBe("attempt_mismatch");
	});

	it("rejects attempts on structural operations", () => {
		const { state, opId } = activeStructural();
		expect(violation(state, { type: "attempt_begin", attempt: attempt(opId, 0) }).code).toBe("invalid_transition");
	});

	it("rejects overflow recovery on tree navigation", () => {
		const { state, opId } = activeStructural("tree_navigation");
		expect(violation(state, { type: "stage", operationId: opId, stage: "recovering_overflow" }).code).toBe(
			"invalid_transition",
		);
	});

	it("rejects prompt operations entering structural stages and vice versa", () => {
		const prompt = activePrompt();
		const promptId = prompt.tag === "active" ? prompt.operation.operationId : "";
		expect(violation(prompt, { type: "stage", operationId: promptId, stage: "structural_running" }).code).toBe(
			"invalid_transition",
		);
		const { state, opId } = activeStructural();
		expect(violation(state, { type: "stage", operationId: opId, stage: "save_point" }).code).toBe(
			"invalid_transition",
		);
	});

	it("rejects recovery attempt with the initial reason and initial attempt from recovery", () => {
		const { state, attemptRef, opId } = activePromptRunning();
		const ended = endAttempt(state, attemptRef, "overflow");
		const recovering = apply(ended, { type: "stage", operationId: opId, stage: "recovering_overflow" });
		expect(violation(recovering, { type: "attempt_begin", attempt: attempt(opId, 1, "initial") }).code).toBe(
			"invalid_transition",
		);
		expect(violation(activePrompt(), { type: "attempt_begin", attempt: attempt("wrong", 0) }).code).toBe(
			"stale_operation",
		);
	});

	it("rejects attempt_end mismatches and attempt_end from save_point", () => {
		const { state, attemptRef, opId } = activePromptRunning();
		expect(violation(state, { type: "attempt_end", attemptId: "op-x:a9", outcome: "completed" }).code).toBe(
			"attempt_mismatch",
		);
		const saved = apply(state, { type: "stage", operationId: opId, stage: "save_point" });
		expect(
			violation(saved, { type: "attempt_end", attemptId: attemptRef.attemptId, outcome: "completed" }).code,
		).toBe("invalid_transition");
	});

	it("rejects abort_request for another operation", () => {
		const { state } = activePromptRunning();
		expect(violation(state, { type: "abort_request", operationId: "op-other" }).code).toBe("stale_operation");
	});

	it("rejects settle_finish before settling begins", () => {
		const active = activePrompt();
		const opId = active.tag === "active" ? active.operation.operationId : "";
		expect(violation(active, { type: "settle_finish", operationId: opId }).code).toBe("invalid_transition");
		expect(violation(active, { type: "settle_finish", operationId: "op-other" }).code).toBe("invalid_transition");
	});
});

describe("reduceHarnessLifecycle purity", () => {
	it("does not mutate frozen input state", () => {
		const idle = initialHarnessLifecycleState();
		const state = activePrompt();
		deepFreeze(state);
		const opId = state.tag === "active" ? state.operation.operationId : "";
		expect(() =>
			reduceHarnessLifecycle(state, { type: "stage", operationId: opId, stage: "recovering_overflow" }),
		).not.toThrow();
		expect(() => reduceHarnessLifecycle(idle, { type: "begin", operation: op("prompt") })).not.toThrow();
	});

	it("is deterministic for identical inputs", () => {
		const { state, attemptRef } = activePromptRunning();
		const command: HarnessLifecycleCommand = {
			type: "attempt_end",
			attemptId: attemptRef.attemptId,
			outcome: "failed",
		};
		const first = reduceHarnessLifecycle(state, command);
		const second = reduceHarnessLifecycle(state, command);
		expect(first).toEqual(second);
	});

	it("returns fresh state objects on accepted transitions", () => {
		const state = activePrompt();
		const opId = state.tag === "active" ? state.operation.operationId : "";
		const next = reduceHarnessLifecycle(state, { type: "abort_request", operationId: opId });
		expect(next.ok && next.value).not.toBe(state);
	});
});

function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
	Object.freeze(value);
}
