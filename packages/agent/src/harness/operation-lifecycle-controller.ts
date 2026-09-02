/**
 * Owns the single mutable copy of the harness lifecycle state.
 *
 * The controller is the only writer: it builds commands, runs them through
 * the pure reducer, and performs the side effects the reducer is forbidden
 * from touching — clock reads, ID allocation, abort-signal delivery, and
 * settlement of the operation's `settled` promise.
 *
 * Lease discipline: every mutating method requires the `OperationLease`
 * returned by `begin`. A lease that is not the current record fails closed,
 * so a stale async continuation from a finished operation can never mutate
 * the state of a newer one. `settle()` is the only path from `active` to
 * `idle`, runs the caller's finalizer inside the `settling` barrier, and is
 * guarded against double invocation at both controller and reducer level.
 *
 * The `settled` promise resolves with the recorded outcome and never
 * rejects; finalizer failures surface only through the `settle()` rejection,
 * so callers cannot strand an unhandled rejection by ignoring `lease.settled`.
 */

import { createImmutableSnapshot } from "../plain-data.ts";
import { AgentHarnessError } from "./errors.ts";
import { initialHarnessLifecycleState, reduceHarnessLifecycle } from "./operation-lifecycle-reducer.ts";
import type {
	HarnessAttemptOutcome,
	HarnessAttemptRef,
	HarnessAttemptSummary,
	HarnessLifecycleCommand,
	HarnessLifecycleDependencies,
	HarnessLifecycleState,
	HarnessLifecycleViolation,
	HarnessOperationKind,
	HarnessOperationOutcome,
	HarnessOperationRef,
} from "./operation-lifecycle-types.ts";

export interface OperationLease {
	readonly operation: HarnessOperationRef;
	readonly signal: AbortSignal;
	/** Resolves once with the recorded outcome when the operation finishes settling. Never rejects. */
	readonly settled: Promise<HarnessOperationOutcome>;
}

export interface AttemptLease {
	readonly attempt: HarnessAttemptRef;
	/** The owning operation's signal. Attempts never own a separate AbortController. */
	readonly signal: AbortSignal;
}

export interface HarnessAbortCapture {
	readonly target?: OperationLease;
	readonly signalDelivered: boolean;
}

interface OperationRecord {
	readonly lease: OperationLease;
	readonly controller: AbortController;
	readonly attemptFinishTimes: Map<string, number>;
	settleStarted: boolean;
	resolveSettled: (outcome: HarnessOperationOutcome) => void;
}

/**
 * Deep-freeze a reducer-produced state in place.
 *
 * Operation and attempt refs are already frozen at creation, and the reducer
 * allocates fresh state objects per transition, so this is O(attempts) per
 * transition rather than a clone. That keeps `getSnapshot()` free to hand out
 * the live reference: `readonly` is compile-time only, but a frozen object
 * resists `Reflect.set` from extension code at runtime too.
 */
function freezeLifecycleState(state: HarnessLifecycleState): HarnessLifecycleState {
	if (state.tag !== "idle") {
		for (const settled of state.attempts) Object.freeze(settled);
		Object.freeze(state.attempts);
	}
	if (state.tag === "settling") Object.freeze(state.outcome);
	return Object.freeze(state);
}

export class OperationLifecycleController {
	private readonly deps: HarnessLifecycleDependencies;
	private state: HarnessLifecycleState = freezeLifecycleState(initialHarnessLifecycleState());
	private current?: OperationRecord;
	private readonly idleWaiters = new Set<() => void>();

	constructor(deps: HarnessLifecycleDependencies) {
		this.deps = deps;
	}

	getSnapshot(): Readonly<HarnessLifecycleState> {
		return this.state;
	}

	getCurrentOperation(): HarnessOperationRef | undefined {
		return this.state.tag === "idle" ? undefined : this.state.operation;
	}

	begin(kind: HarnessOperationKind): OperationLease {
		const sequence = this.state.tag === "idle" ? this.state.lastSequence + 1 : -1;
		// Frozen once here so every downstream copy — lease, getters, and event
		// payloads — shares one identity no listener can rewrite.
		const operation = createImmutableSnapshot<HarnessOperationRef>({
			operationId: this.deps.createOperationId(),
			sequence,
			kind,
			startedAtMs: this.deps.now(),
		});
		this.apply({ type: "begin", operation });
		const controller = new AbortController();
		let resolveSettled: (outcome: HarnessOperationOutcome) => void = () => undefined;
		const settled = new Promise<HarnessOperationOutcome>((resolve) => {
			resolveSettled = resolve;
		});
		const lease: OperationLease = { operation, signal: controller.signal, settled };
		this.current = { lease, controller, attemptFinishTimes: new Map(), settleStarted: false, resolveSettled };
		return lease;
	}

	setStage(lease: OperationLease, stage: Extract<HarnessLifecycleCommand, { type: "stage" }>["stage"]): void {
		this.expectCurrentLease(lease);
		this.apply({ type: "stage", operationId: lease.operation.operationId, stage });
	}

	beginAttempt(lease: OperationLease, reason: HarnessAttemptRef["reason"]): AttemptLease {
		const record = this.expectCurrentLease(lease);
		const active = this.expectActive();
		const attempt = createImmutableSnapshot<HarnessAttemptRef>({
			operationId: lease.operation.operationId,
			attemptId: `${lease.operation.operationId}:a${active.attempts.length}`,
			index: active.attempts.length,
			reason,
			startedAtMs: this.deps.now(),
		});
		this.apply({ type: "attempt_begin", attempt });
		record.attemptFinishTimes.delete(attempt.attemptId);
		return { attempt, signal: lease.signal };
	}

	finishAttempt(lease: OperationLease, attempt: AttemptLease, outcome: HarnessAttemptOutcome): void {
		const record = this.expectCurrentLease(lease);
		this.apply({ type: "attempt_end", attemptId: attempt.attempt.attemptId, outcome });
		record.attemptFinishTimes.set(attempt.attempt.attemptId, this.deps.now());
	}

	/** Captures the current operation as the abort target; never targets operations started later. */
	requestAbort(): HarnessAbortCapture {
		const record = this.current;
		if (record === undefined || this.state.tag === "idle") {
			return { signalDelivered: false };
		}
		if (this.state.tag === "settling") {
			return { target: record.lease, signalDelivered: false };
		}
		this.apply({ type: "abort_request", operationId: record.lease.operation.operationId });
		if (!record.controller.signal.aborted) record.controller.abort();
		return { target: record.lease, signalDelivered: true };
	}

	/**
	 * Sole active -> idle path. Runs `finalize` inside the settling barrier, then
	 * releases state and resolves the lease. A finalizer failure still completes
	 * the state release and resolves `lease.settled`, then rejects this call.
	 */
	async settle(
		lease: OperationLease,
		outcome: HarnessOperationOutcome,
		finalize: () => Promise<void>,
	): Promise<HarnessOperationOutcome> {
		const record = this.expectCurrentLease(lease);
		if (record.settleStarted) {
			throw new AgentHarnessError("invalid_state", `Operation ${lease.operation.operationId} is already settling`);
		}
		// A rejected settle_begin (e.g. an attempt still open) is not a settlement.
		// Marking it as one would wedge the operation: every later settle() would
		// report "already settling" while the state never left `active`, and
		// `lease.settled` plus every waitForIdle() waiter would hang forever.
		this.apply({ type: "settle_begin", operationId: lease.operation.operationId, outcome });
		record.settleStarted = true;
		let finalizeError: unknown;
		try {
			await finalize();
		} catch (error) {
			finalizeError = error;
		}
		this.apply({ type: "settle_finish", operationId: lease.operation.operationId });
		this.current = undefined;
		record.resolveSettled(outcome);
		for (const release of [...this.idleWaiters]) {
			this.idleWaiters.delete(release);
			release();
		}
		if (finalizeError !== undefined) throw finalizeError;
		return outcome;
	}

	/** Bounded attempt summaries for the current operation; no transcripts. */
	getAttemptSummaries(lease: OperationLease): readonly HarnessAttemptSummary[] {
		const record = this.expectCurrentLease(lease);
		const attempts = this.state.tag === "idle" ? [] : this.state.attempts;
		return attempts.map(({ attempt, outcome }) => ({
			attemptId: attempt.attemptId,
			index: attempt.index,
			reason: attempt.reason,
			outcome,
			startedAtMs: attempt.startedAtMs,
			finishedAtMs: record.attemptFinishTimes.get(attempt.attemptId) ?? attempt.startedAtMs,
		}));
	}

	/** The recorded summary for one attempt of the current operation. */
	getAttemptSummary(lease: OperationLease, attempt: AttemptLease): HarnessAttemptSummary {
		const attemptId = attempt.attempt.attemptId;
		const summary = this.getAttemptSummaries(lease).find((candidate) => candidate.attemptId === attemptId);
		if (summary === undefined) {
			throw new AgentHarnessError("invalid_state", `No summary recorded for attempt ${attemptId}`);
		}
		return summary;
	}

	async waitForIdle(): Promise<void> {
		if (this.state.tag === "idle") return;
		await new Promise<void>((resolve) => {
			this.idleWaiters.add(resolve);
		});
	}

	private expectActive(): Extract<HarnessLifecycleState, { tag: "active" }> {
		if (this.state.tag !== "active") {
			throw new AgentHarnessError("invalid_state", `Expected an active operation, state is ${this.state.tag}`);
		}
		return this.state;
	}

	private expectCurrentLease(lease: OperationLease): OperationRecord {
		const record = this.current;
		if (record === undefined || record.lease !== lease) {
			throw new AgentHarnessError(
				"invalid_state",
				`Stale operation lease for ${lease.operation.operationId}; the operation no longer owns lifecycle state`,
			);
		}
		return record;
	}

	private apply(command: HarnessLifecycleCommand): void {
		const next = reduceHarnessLifecycle(this.state, command);
		if (!next.ok) throw this.asHarnessError(next.error);
		this.state = freezeLifecycleState(next.value);
	}

	private asHarnessError(violation: HarnessLifecycleViolation): AgentHarnessError {
		return new AgentHarnessError(violation.code === "busy" ? "busy" : "invalid_state", violation.message, violation);
	}
}
