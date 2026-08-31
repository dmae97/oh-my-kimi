/**
 * Pure transition function for the harness operation lifecycle.
 *
 * Given the current state and one command, returns the next state or a
 * classified violation. It performs no side effects: it does not read a
 * clock, allocate identifiers, emit events, flush sessions, or touch abort
 * signals. The controller supplies all of those around it.
 *
 * The transition table encodes the plan's legal moves plus one documented
 * conservative addition: `structural_running -> committing` marks the single
 * declared commit point of a structural operation. Every other transition not
 * listed here is rejected, and rejection never mutates the input state.
 */

import {
	type HarnessLifecycleCommand,
	type HarnessLifecycleResult,
	type HarnessLifecycleState,
	HarnessLifecycleViolation,
	type HarnessLifecycleViolationCode,
	type HarnessOperationKind,
	PROMPT_FAMILY_KINDS,
} from "./operation-lifecycle-types.ts";

type ActiveState = Extract<HarnessLifecycleState, { tag: "active" }>;
type OwnedState = Extract<HarnessLifecycleState, { tag: "active" | "settling" }>;
type Result = HarnessLifecycleResult<HarnessLifecycleState>;

export function initialHarnessLifecycleState(): HarnessLifecycleState {
	return { tag: "idle", lastSequence: 0 };
}

function reject(
	code: HarnessLifecycleViolationCode,
	message: string,
	state: HarnessLifecycleState,
	command: HarnessLifecycleCommand,
): HarnessLifecycleResult<never> {
	return { ok: false, error: new HarnessLifecycleViolation(code, message, state, command) };
}

function isPromptFamily(kind: HarnessOperationKind): boolean {
	return PROMPT_FAMILY_KINDS.includes(kind);
}

function notIdle(state: HarnessLifecycleState, command: HarnessLifecycleCommand, action: string): Result {
	return reject("invalid_transition", `Cannot ${action} without an active operation`, state, command);
}

/** Commands carrying an operationId must name the current operation. */
function expectCurrentOperation(
	state: OwnedState,
	operationId: string,
	command: HarnessLifecycleCommand,
): HarnessLifecycleResult<OwnedState> {
	if (state.operation.operationId !== operationId) {
		return reject(
			"stale_operation",
			`Command targets operation ${operationId} but current operation is ${state.operation.operationId}`,
			state,
			command,
		);
	}
	return { ok: true, value: state };
}

function reduceBegin(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "begin" }>,
): Result {
	if (state.tag !== "idle") {
		return reject("busy", "Cannot begin a new operation while another is active or settling", state, command);
	}
	if (command.operation.sequence !== state.lastSequence + 1) {
		return reject(
			"sequence_violation",
			`Operation sequence ${command.operation.sequence} is not lastSequence + 1 (${state.lastSequence + 1})`,
			state,
			command,
		);
	}
	return {
		ok: true,
		value: { tag: "active", operation: command.operation, stage: "preparing", attempts: [], abortRequested: false },
	};
}

function isLegalStageMove(state: ActiveState, to: ActiveState["stage"]): boolean {
	const from = state.stage;
	const kind = state.operation.kind;
	if (from === "attempt_running" && to === "save_point") return state.attempt !== undefined;
	if (from === "save_point" && to === "attempt_running") return state.attempt !== undefined;
	if (from === "preparing" && to === "recovering_overflow") return isPromptFamily(kind) && state.attempt === undefined;
	if (from === "preparing" && to === "structural_running") return !isPromptFamily(kind);
	return from === "structural_running" && to === "committing";
}

function reduceStage(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "stage" }>,
): Result {
	if (state.tag === "idle") return notIdle(state, command, "change stage");
	if (state.tag === "settling")
		return reject("invalid_transition", "Cannot change stage while settling", state, command);
	const current = expectCurrentOperation(state, command.operationId, command);
	if (!current.ok) return current;
	if (!isLegalStageMove(state, command.stage)) {
		return reject(
			"invalid_transition",
			`Illegal stage transition ${state.stage} -> ${command.stage} for ${state.operation.kind}`,
			state,
			command,
		);
	}
	return { ok: true, value: { ...state, stage: command.stage } };
}

function reduceAttemptBegin(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "attempt_begin" }>,
): Result {
	if (state.tag === "idle") return notIdle(state, command, "begin an attempt");
	if (state.tag === "settling")
		return reject("invalid_transition", "Cannot begin an attempt while settling", state, command);
	const current = expectCurrentOperation(state, command.attempt.operationId, command);
	if (!current.ok) return current;
	if (state.attempt !== undefined) {
		return reject("attempt_mismatch", `Attempt ${state.attempt.attemptId} is still active`, state, command);
	}
	if (!isPromptFamily(state.operation.kind)) {
		return reject("invalid_transition", `${state.operation.kind} operations do not run attempts`, state, command);
	}
	if (command.attempt.index !== state.attempts.length) {
		return reject(
			"sequence_violation",
			`Attempt index ${command.attempt.index} is not the next index ${state.attempts.length}`,
			state,
			command,
		);
	}
	const fromPreparing =
		state.stage === "preparing" && command.attempt.index === 0 && command.attempt.reason === "initial";
	const fromRecovery =
		state.stage === "recovering_overflow" &&
		command.attempt.index > 0 &&
		command.attempt.reason === "context_overflow_recovery";
	if (!fromPreparing && !fromRecovery) {
		return reject(
			"invalid_transition",
			`Cannot begin attempt ${command.attempt.attemptId} (${command.attempt.reason}) from stage ${state.stage}`,
			state,
			command,
		);
	}
	return { ok: true, value: { ...state, stage: "attempt_running", attempt: command.attempt } };
}

function reduceAttemptEnd(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "attempt_end" }>,
): Result {
	if (state.tag === "idle") return notIdle(state, command, "end an attempt");
	if (state.tag === "settling")
		return reject("invalid_transition", "Cannot end an attempt while settling", state, command);
	if (state.attempt === undefined) return reject("attempt_mismatch", "No active attempt to end", state, command);
	if (state.attempt.attemptId !== command.attemptId) {
		return reject(
			"attempt_mismatch",
			`Attempt end names ${command.attemptId} but active attempt is ${state.attempt.attemptId}`,
			state,
			command,
		);
	}
	// save_point is an intra-attempt stage between provider turns; the attempt
	// remains logically running there, so it may end from either stage.
	if (state.stage !== "attempt_running" && state.stage !== "save_point") {
		return reject("invalid_transition", `Cannot end an attempt from stage ${state.stage}`, state, command);
	}
	const { attempt } = state;
	return {
		ok: true,
		value: {
			...state,
			stage: "preparing",
			attempt: undefined,
			attempts: [...state.attempts, { attempt, outcome: command.outcome }],
		},
	};
}

function reduceAbortRequest(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "abort_request" }>,
): Result {
	if (state.tag === "idle") return notIdle(state, command, "abort");
	if (state.tag === "settling") return reject("invalid_transition", "Cannot abort while settling", state, command);
	const current = expectCurrentOperation(state, command.operationId, command);
	if (!current.ok) return current;
	return { ok: true, value: { ...state, abortRequested: true } };
}

function reduceSettleBegin(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "settle_begin" }>,
): Result {
	if (state.tag === "idle") return notIdle(state, command, "settle");
	if (state.tag === "settling") return reject("invalid_transition", "Operation is already settling", state, command);
	const current = expectCurrentOperation(state, command.operationId, command);
	if (!current.ok) return current;
	return {
		ok: true,
		value: {
			tag: "settling",
			operation: state.operation,
			outcome: command.outcome,
			attempts: state.attempts,
			abortRequested: state.abortRequested,
		},
	};
}

function reduceSettleFinish(
	state: HarnessLifecycleState,
	command: Extract<HarnessLifecycleCommand, { type: "settle_finish" }>,
): Result {
	if (state.tag === "idle") return notIdle(state, command, "finish settling");
	if (state.tag === "active")
		return reject("invalid_transition", "Operation must pass through settling before finishing", state, command);
	const current = expectCurrentOperation(state, command.operationId, command);
	if (!current.ok) return current;
	return { ok: true, value: { tag: "idle", lastSequence: state.operation.sequence } };
}

export function reduceHarnessLifecycle(state: HarnessLifecycleState, command: HarnessLifecycleCommand): Result {
	switch (command.type) {
		case "begin":
			return reduceBegin(state, command);
		case "stage":
			return reduceStage(state, command);
		case "attempt_begin":
			return reduceAttemptBegin(state, command);
		case "attempt_end":
			return reduceAttemptEnd(state, command);
		case "abort_request":
			return reduceAbortRequest(state, command);
		case "settle_begin":
			return reduceSettleBegin(state, command);
		case "settle_finish":
			return reduceSettleFinish(state, command);
		default: {
			const unknownCommand: never = command;
			throw new HarnessLifecycleViolation("invalid_transition", "Unknown lifecycle command", state, unknownCommand);
		}
	}
}
