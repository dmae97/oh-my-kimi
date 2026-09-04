/**
 * Operation trace vocabulary: the normalized event stream two runtimes must
 * agree on before either can be called the operation authority.
 *
 * The CLI `AgentSession` and the core `AgentHarness` both drive an operation
 * lifecycle today. Converging them (FND-003, Stage A) needs a common, timing-
 * free record of what each one did: which operations started, which attempts
 * ran and how they closed, which effects were left uncertain, which deferred
 * commands and session writes were accepted, and how the operation settled.
 * This module fixes that vocabulary and derives it mechanically from the pure
 * lifecycle reducer, so a trace is a function of the command stream and not of
 * whichever runtime happened to emit it.
 *
 * Traces carry no wall-clock data and no human wording: `TraceOutcome` keeps
 * the public failure `code` (a blocker dimension) and drops the message (a
 * non-blocker). Two runtimes that produce the same trace digest for the same
 * scenario are behaviourally indistinguishable at the lifecycle boundary.
 */

import { canonicalDigest } from "./canonical-digest.ts";
import { initialHarnessLifecycleState, reduceHarnessLifecycle } from "./operation-lifecycle-reducer.ts";
import type {
	HarnessAttemptOutcome,
	HarnessAttemptReason,
	HarnessLifecycleCommand,
	HarnessLifecycleResult,
	HarnessLifecycleState,
	HarnessOperationKind,
	HarnessOperationOutcome,
	HarnessOperationStage,
} from "./operation-lifecycle-types.ts";

export const OPERATION_TRACE_SCHEMA_VERSION = "omk.operation-trace.v1" as const;

/** Public outcome projection: status and failure code only, never wording. */
export type TraceOutcome =
	| { readonly status: "completed" }
	| { readonly status: "failed"; readonly code: string }
	| { readonly status: "aborted" }
	| { readonly status: "cancelled" };

/** Events derived from lifecycle commands. Emitted only by `OperationTraceRecorder.apply`. */
export type LifecycleTraceEventBody =
	| {
			readonly type: "operation_started";
			readonly operationId: string;
			readonly kind: HarnessOperationKind;
			readonly sequence: number;
	  }
	| { readonly type: "stage_changed"; readonly operationId: string; readonly stage: HarnessOperationStage }
	| {
			readonly type: "attempt_started";
			readonly operationId: string;
			readonly attemptId: string;
			readonly index: number;
			readonly reason: HarnessAttemptReason;
	  }
	| {
			readonly type: "attempt_finished";
			readonly operationId: string;
			readonly attemptId: string;
			readonly outcome: HarnessAttemptOutcome;
	  }
	| { readonly type: "abort_requested"; readonly operationId: string }
	| { readonly type: "settlement_started"; readonly operationId: string; readonly outcome: TraceOutcome }
	| { readonly type: "operation_settled"; readonly operationId: string; readonly outcome: TraceOutcome };

/** Events reported by subsystems around the lifecycle (effects, deferred commands, session writes). */
export type ExternalTraceEventBody =
	| { readonly type: "effect_prepared"; readonly operationId: string; readonly effectId: string }
	| { readonly type: "effect_uncertain"; readonly operationId: string; readonly effectId: string }
	| { readonly type: "effect_reconciled"; readonly operationId: string; readonly effectId: string }
	| {
			readonly type: "deferred_command_accepted";
			readonly commandId: string;
			readonly name: string;
			readonly operationId?: string;
	  }
	| {
			readonly type: "session_write_accepted";
			readonly writeSequence: number;
			readonly writeType: string;
			readonly operationId?: string;
	  };

export type OperationTraceEventBody = LifecycleTraceEventBody | ExternalTraceEventBody;

/** One trace entry. `seq` is 1-based and strictly increasing within a trace. */
export type OperationTraceEvent = OperationTraceEventBody & { readonly seq: number };

export interface OperationTraceDocument {
	readonly schemaVersion: typeof OPERATION_TRACE_SCHEMA_VERSION;
	readonly events: readonly OperationTraceEvent[];
}

export function projectTraceOutcome(outcome: HarnessOperationOutcome): TraceOutcome {
	switch (outcome.status) {
		case "completed":
			return { status: "completed" };
		case "failed":
			return { status: "failed", code: outcome.code };
		case "aborted":
			return { status: "aborted" };
		case "cancelled":
			return { status: "cancelled" };
	}
}

/**
 * The trace events one accepted lifecycle command produces. Pure: it reads the
 * pre-transition state only to recover identities the command omits (the
 * operation of an `attempt_end`, the outcome recorded at `settle_begin`).
 */
export function traceEventsForCommand(
	before: HarnessLifecycleState,
	command: HarnessLifecycleCommand,
): readonly LifecycleTraceEventBody[] {
	switch (command.type) {
		case "begin":
			return [
				{
					type: "operation_started",
					operationId: command.operation.operationId,
					kind: command.operation.kind,
					sequence: command.operation.sequence,
				},
			];
		case "stage":
			return [{ type: "stage_changed", operationId: command.operationId, stage: command.stage }];
		case "attempt_begin":
			return [
				{
					type: "attempt_started",
					operationId: command.attempt.operationId,
					attemptId: command.attempt.attemptId,
					index: command.attempt.index,
					reason: command.attempt.reason,
				},
			];
		case "attempt_end":
			if (before.tag === "idle") return [];
			return [
				{
					type: "attempt_finished",
					operationId: before.operation.operationId,
					attemptId: command.attemptId,
					outcome: command.outcome,
				},
			];
		case "abort_request":
			return [{ type: "abort_requested", operationId: command.operationId }];
		case "settle_begin":
			return [
				{
					type: "settlement_started",
					operationId: command.operationId,
					outcome: projectTraceOutcome(command.outcome),
				},
			];
		case "settle_finish":
			if (before.tag !== "settling") return [];
			return [
				{
					type: "operation_settled",
					operationId: command.operationId,
					outcome: projectTraceOutcome(before.outcome),
				},
			];
	}
}

export type TraceRecordResult =
	| { readonly ok: true; readonly event: OperationTraceEvent }
	| { readonly ok: false; readonly code: "stale_operation" | "no_active_operation"; readonly message: string };

/**
 * Drives the pure lifecycle reducer and appends the derived trace. A rejected
 * command records nothing: the trace only ever describes accepted transitions,
 * so two recorders fed the same accepted command stream produce byte-identical
 * traces regardless of how many illegal commands were refused in between.
 */
export class OperationTraceRecorder {
	private readonly events: OperationTraceEvent[] = [];
	private state: HarnessLifecycleState;

	constructor(initial: HarnessLifecycleState = initialHarnessLifecycleState()) {
		this.state = initial;
	}

	get lifecycleState(): HarnessLifecycleState {
		return this.state;
	}

	get size(): number {
		return this.events.length;
	}

	apply(command: HarnessLifecycleCommand): HarnessLifecycleResult<HarnessLifecycleState> {
		const result = reduceHarnessLifecycle(this.state, command);
		if (!result.ok) return result;
		for (const body of traceEventsForCommand(this.state, command)) this.push(body);
		this.state = result.value;
		return result;
	}

	/** Record a subsystem event. Effect events must name the current operation. */
	record(body: ExternalTraceEventBody): TraceRecordResult {
		if (body.operationId !== undefined) {
			if (this.state.tag === "idle") {
				return {
					ok: false,
					code: "no_active_operation",
					message: `${body.type} names ${body.operationId} while idle`,
				};
			}
			if (this.state.operation.operationId !== body.operationId) {
				return {
					ok: false,
					code: "stale_operation",
					message: `${body.type} names ${body.operationId} but current operation is ${this.state.operation.operationId}`,
				};
			}
		} else if (body.type.startsWith("effect_")) {
			return { ok: false, code: "no_active_operation", message: `${body.type} requires an operationId` };
		}
		return { ok: true, event: this.push(body) };
	}

	snapshot(): OperationTraceDocument {
		return { schemaVersion: OPERATION_TRACE_SCHEMA_VERSION, events: [...this.events] };
	}

	digest(): string {
		return computeTraceDigest(this.events);
	}

	private push(body: OperationTraceEventBody): OperationTraceEvent {
		const event: OperationTraceEvent = Object.freeze({ ...body, seq: this.events.length + 1 });
		this.events.push(event);
		return event;
	}
}

/** Canonical SHA-256 over the schema version and the ordered event list. */
export function computeTraceDigest(events: readonly OperationTraceEvent[]): string {
	return canonicalDigest({ schemaVersion: OPERATION_TRACE_SCHEMA_VERSION, events });
}
