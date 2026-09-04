import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialHarnessLifecycleState, reduceHarnessLifecycle } from "../../src/harness/operation-lifecycle-reducer.ts";
import type {
	HarnessLifecycleCommand,
	HarnessLifecycleState,
	HarnessOperationKind,
} from "../../src/harness/operation-lifecycle-types.ts";
import {
	computeTraceDigest,
	OPERATION_TRACE_SCHEMA_VERSION,
	OperationTraceRecorder,
	projectTraceOutcome,
	traceEventsForCommand,
} from "../../src/harness/operation-trace.ts";
import { compareOperationTraces, summarizeTrace } from "../../src/harness/operation-trace-divergence.ts";

const OP = { operationId: "op-1", sequence: 1, kind: "prompt" as const, startedAtMs: 0 };
const ATTEMPT = { operationId: "op-1", attemptId: "op-1:a0", index: 0, reason: "initial" as const, startedAtMs: 0 };

function apply(recorder: OperationTraceRecorder, ...commands: HarnessLifecycleCommand[]): void {
	for (const command of commands) {
		const result = recorder.apply(command);
		if (!result.ok) throw result.error;
	}
}

/** A complete prompt operation: begin, one attempt, settle. */
function promptScenario(
	recorder: OperationTraceRecorder,
	options: {
		readonly attemptOutcome?: "completed" | "failed";
		readonly failCode?: string;
		readonly savePoint?: boolean;
	} = {},
): void {
	apply(recorder, { type: "begin", operation: OP }, { type: "attempt_begin", attempt: ATTEMPT });
	if (options.savePoint) {
		apply(
			recorder,
			{ type: "stage", operationId: "op-1", stage: "save_point" },
			{ type: "stage", operationId: "op-1", stage: "attempt_running" },
		);
	}
	apply(recorder, { type: "attempt_end", attemptId: "op-1:a0", outcome: options.attemptOutcome ?? "completed" });
	const outcome =
		options.failCode === undefined
			? ({ status: "completed" } as const)
			: ({ status: "failed", code: options.failCode, message: "wording differs" } as const);
	apply(
		recorder,
		{ type: "settle_begin", operationId: "op-1", outcome },
		{ type: "settle_finish", operationId: "op-1" },
	);
}

describe("traceEventsForCommand", () => {
	it("derives one normalized event per accepted lifecycle command", () => {
		const idle = initialHarnessLifecycleState();
		expect(traceEventsForCommand(idle, { type: "begin", operation: OP })).toEqual([
			{ type: "operation_started", operationId: "op-1", kind: "prompt", sequence: 1 },
		]);
		const active: HarnessLifecycleState = {
			tag: "active",
			operation: OP,
			stage: "attempt_running",
			attempt: ATTEMPT,
			attempts: [],
			abortRequested: false,
		};
		expect(traceEventsForCommand(active, { type: "attempt_end", attemptId: "op-1:a0", outcome: "overflow" })).toEqual(
			[{ type: "attempt_finished", operationId: "op-1", attemptId: "op-1:a0", outcome: "overflow" }],
		);
		const settling: HarnessLifecycleState = {
			tag: "settling",
			operation: OP,
			outcome: { status: "failed", code: "session", message: "flush failed" },
			attempts: [],
			abortRequested: false,
		};
		expect(traceEventsForCommand(settling, { type: "settle_finish", operationId: "op-1" })).toEqual([
			{ type: "operation_settled", operationId: "op-1", outcome: { status: "failed", code: "session" } },
		]);
	});

	it("projects outcomes to status and code only", () => {
		expect(projectTraceOutcome({ status: "failed", code: "session", message: "any" })).toEqual({
			status: "failed",
			code: "session",
		});
		expect(projectTraceOutcome({ status: "aborted", reason: "user" })).toEqual({ status: "aborted" });
		expect(projectTraceOutcome({ status: "cancelled", reason: "hook" })).toEqual({ status: "cancelled" });
	});
});

describe("OperationTraceRecorder", () => {
	it("appends strictly increasing seq for accepted commands and nothing for rejected ones", () => {
		const recorder = new OperationTraceRecorder();
		const rejected = recorder.apply({ type: "settle_finish", operationId: "op-1" });
		expect(rejected.ok).toBe(false);
		expect(recorder.size).toBe(0);
		promptScenario(recorder);
		const events = recorder.snapshot().events;
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(events.map((event) => event.type)).toEqual([
			"operation_started",
			"attempt_started",
			"attempt_finished",
			"settlement_started",
			"operation_settled",
		]);
		expect(recorder.snapshot().schemaVersion).toBe(OPERATION_TRACE_SCHEMA_VERSION);
		expect(recorder.lifecycleState.tag).toBe("idle");
		expect(Object.isFrozen(events[0])).toBe(true);
	});

	it("binds effect events to the current operation and rejects stale or idle references", () => {
		const recorder = new OperationTraceRecorder();
		expect(recorder.record({ type: "effect_prepared", operationId: "op-1", effectId: "e1" })).toMatchObject({
			ok: false,
			code: "no_active_operation",
		});
		apply(recorder, { type: "begin", operation: OP });
		expect(recorder.record({ type: "effect_prepared", operationId: "op-9", effectId: "e1" })).toMatchObject({
			ok: false,
			code: "stale_operation",
		});
		const accepted = recorder.record({ type: "effect_uncertain", operationId: "op-1", effectId: "e1" });
		expect(accepted).toMatchObject({ ok: true, event: { type: "effect_uncertain", seq: 2 } });
	});

	it("accepts deferred-command and session-write events while idle", () => {
		const recorder = new OperationTraceRecorder();
		expect(recorder.record({ type: "deferred_command_accepted", commandId: "cmd-1", name: "compact" }).ok).toBe(true);
		expect(recorder.record({ type: "session_write_accepted", writeSequence: 1, writeType: "label" }).ok).toBe(true);
		expect(recorder.size).toBe(2);
	});

	it("digest depends on the accepted stream, not on interleaved rejections", () => {
		const clean = new OperationTraceRecorder();
		promptScenario(clean);
		const noisy = new OperationTraceRecorder();
		noisy.apply({ type: "abort_request", operationId: "op-1" });
		noisy.apply({ type: "begin", operation: OP });
		noisy.apply({ type: "begin", operation: OP });
		noisy.apply({ type: "attempt_begin", attempt: ATTEMPT });
		noisy.apply({ type: "attempt_begin", attempt: ATTEMPT });
		noisy.apply({ type: "attempt_end", attemptId: "op-1:a0", outcome: "completed" });
		noisy.apply({ type: "settle_begin", operationId: "op-1", outcome: { status: "completed" } });
		noisy.apply({ type: "settle_finish", operationId: "op-1" });
		expect(noisy.digest()).toBe(clean.digest());
	});

	it("digest ignores failure wording but keeps the public code", () => {
		const left = new OperationTraceRecorder();
		promptScenario(left, { failCode: "session" });
		const right = new OperationTraceRecorder();
		apply(
			right,
			{ type: "begin", operation: OP },
			{ type: "attempt_begin", attempt: ATTEMPT },
			{ type: "attempt_end", attemptId: "op-1:a0", outcome: "completed" },
			{
				type: "settle_begin",
				operationId: "op-1",
				outcome: { status: "failed", code: "session", message: "other" },
			},
			{ type: "settle_finish", operationId: "op-1" },
		);
		expect(right.digest()).toBe(left.digest());
		const otherCode = new OperationTraceRecorder();
		promptScenario(otherCode, { failCode: "provider" });
		expect(otherCode.digest()).not.toBe(left.digest());
	});
});

/** Random walk: propose candidate commands, keep the ones the reducer accepts. */
function candidateCommands(state: HarnessLifecycleState, opSeq: number): HarnessLifecycleCommand[] {
	const kinds: HarnessOperationKind[] = ["prompt", "manual_compaction"];
	if (state.tag === "idle") {
		return kinds.map((kind) => ({
			type: "begin",
			operation: { operationId: `op-${opSeq}`, sequence: opSeq, kind, startedAtMs: 0 },
		}));
	}
	const id = state.operation.operationId;
	if (state.tag === "settling") return [{ type: "settle_finish", operationId: id }];
	const nextAttempt = state.attempts.length;
	return [
		{
			type: "attempt_begin",
			attempt: {
				operationId: id,
				attemptId: `${id}:a${nextAttempt}`,
				index: nextAttempt,
				reason: "initial",
				startedAtMs: 0,
			},
		},
		{ type: "attempt_end", attemptId: `${id}:a${nextAttempt}`, outcome: "completed" },
		{ type: "attempt_end", attemptId: `${id}:a${nextAttempt}`, outcome: "overflow" },
		{ type: "stage", operationId: id, stage: "save_point" },
		{ type: "stage", operationId: id, stage: "attempt_running" },
		{ type: "stage", operationId: id, stage: "recovering_overflow" },
		{ type: "stage", operationId: id, stage: "structural_running" },
		{ type: "stage", operationId: id, stage: "committing" },
		{ type: "abort_request", operationId: id },
		{ type: "settle_begin", operationId: id, outcome: { status: "completed" } },
		{ type: "settle_begin", operationId: id, outcome: { status: "failed", code: "x", message: "m" } },
	];
}

describe("trace determinism (property)", () => {
	it("two recorders fed the same accepted command stream produce identical digests", () => {
		fc.assert(
			fc.property(fc.array(fc.nat({ max: 20 }), { minLength: 1, maxLength: 60 }), (choices) => {
				let state = initialHarnessLifecycleState();
				let opSeq = 1;
				const accepted: HarnessLifecycleCommand[] = [];
				for (const choice of choices) {
					const candidates = candidateCommands(state, opSeq);
					const command = candidates[choice % candidates.length];
					const result = reduceHarnessLifecycle(state, command);
					if (!result.ok) continue;
					if (command.type === "begin") opSeq += 1;
					state = result.value;
					accepted.push(command);
				}
				const left = new OperationTraceRecorder();
				const right = new OperationTraceRecorder();
				for (const command of accepted) {
					expect(left.apply(command).ok).toBe(true);
					expect(right.apply(command).ok).toBe(true);
				}
				expect(left.digest()).toBe(right.digest());
				expect(computeTraceDigest(left.snapshot().events)).toBe(left.digest());
				expect(compareOperationTraces(left.snapshot().events, right.snapshot().events).equal).toBe(true);
				const seqs = left.snapshot().events.map((event) => event.seq);
				expect(seqs).toEqual(seqs.map((_, index) => index + 1));
			}),
			{ numRuns: 300, seed: 0x7a0c0904 },
		);
	});
});

describe("compareOperationTraces", () => {
	it("reports terminal status and public code divergence as blockers", () => {
		const left = new OperationTraceRecorder();
		promptScenario(left);
		const right = new OperationTraceRecorder();
		promptScenario(right, { failCode: "session" });
		const comparison = compareOperationTraces(left.snapshot().events, right.snapshot().events);
		expect(comparison.equal).toBe(false);
		expect(comparison.blockers.map((item) => item.dimension)).toEqual(["terminal_status"]);
		expect(comparison.blockers[0]).toMatchObject({ left: "completed", right: "failed:session", operationIndex: 0 });

		const otherCode = new OperationTraceRecorder();
		promptScenario(otherCode, { failCode: "provider" });
		const codes = compareOperationTraces(right.snapshot().events, otherCode.snapshot().events);
		expect(codes.blockers.map((item) => item.dimension)).toEqual(["public_error_code"]);
	});

	it("treats an extra save-point round trip as a non-blocker", () => {
		const left = new OperationTraceRecorder();
		promptScenario(left);
		const right = new OperationTraceRecorder();
		promptScenario(right, { savePoint: true });
		const comparison = compareOperationTraces(left.snapshot().events, right.snapshot().events);
		expect(comparison.equal).toBe(false);
		expect(comparison.blockers).toEqual([]);
		expect(comparison.nonBlockers.map((item) => item.dimension)).toEqual(["stage_path"]);
	});

	it("flags unresolved effects, accepted-command order, session-write order, and operation count", () => {
		const left = new OperationTraceRecorder();
		apply(left, { type: "begin", operation: OP });
		left.record({ type: "effect_uncertain", operationId: "op-1", effectId: "e1" });
		left.record({ type: "effect_reconciled", operationId: "op-1", effectId: "e1" });
		left.record({ type: "deferred_command_accepted", commandId: "cmd-1", name: "a" });
		left.record({ type: "session_write_accepted", writeSequence: 1, writeType: "message" });
		apply(left, { type: "settle_begin", operationId: "op-1", outcome: { status: "completed" } });
		apply(left, { type: "settle_finish", operationId: "op-1" });

		const right = new OperationTraceRecorder();
		apply(right, { type: "begin", operation: OP });
		right.record({ type: "effect_uncertain", operationId: "op-1", effectId: "e1" });
		right.record({ type: "deferred_command_accepted", commandId: "cmd-2", name: "a" });
		right.record({ type: "session_write_accepted", writeSequence: 1, writeType: "label" });
		apply(right, { type: "settle_begin", operationId: "op-1", outcome: { status: "completed" } });
		apply(right, { type: "settle_finish", operationId: "op-1" });
		apply(right, { type: "begin", operation: { ...OP, operationId: "op-2", sequence: 2 } });

		const comparison = compareOperationTraces(left.snapshot().events, right.snapshot().events);
		expect(comparison.blockers.map((item) => item.dimension).sort()).toEqual([
			"accepted_commands",
			"effect_uncertainty",
			"operation_count",
			"session_write_order",
		]);
		expect(summarizeTrace(right.snapshot().events).operations[0].unresolvedEffectIds).toEqual(["e1"]);
	});
});
