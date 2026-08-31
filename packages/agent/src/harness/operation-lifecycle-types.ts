/**
 * Pure operation-lifecycle model for AgentHarness public operations.
 *
 * One public operation (`prompt`, `skill`, `promptFromTemplate`, `compact`,
 * `navigateTree`) may span several low-level agent attempts. This module
 * declares the identity, state, command, and violation vocabulary used to
 * keep that distinction provable. It imports nothing: no harness, session,
 * provider, or Node types, so it stays a leaf for the import-cycle ratchet
 * and is safe to export from a browser entry point.
 *
 * Reducer-purity note: the reducer never reads a clock, so its `settling`
 * state carries `HarnessSettledAttempt` records (attempt + outcome) rather
 * than wall-clock summaries. The controller, which owns the clock, renders
 * public `HarnessAttemptSummary` values from those records.
 */

/** Public operation kinds that own the harness at most one at a time. */
export type HarnessOperationKind = "prompt" | "skill" | "prompt_template" | "manual_compaction" | "tree_navigation";

/** Prompt-family kinds run agent attempts; structural kinds do not. */
export const PROMPT_FAMILY_KINDS: readonly HarnessOperationKind[] = ["prompt", "skill", "prompt_template"];

export type HarnessOperationStage =
	| "preparing"
	| "attempt_running"
	| "save_point"
	| "recovering_overflow"
	| "structural_running"
	| "committing"
	| "settling";

/** Correlation identity of one public operation. `sequence` is monotonic per harness instance. */
export interface HarnessOperationRef {
	readonly operationId: string;
	readonly sequence: number;
	readonly kind: HarnessOperationKind;
	readonly startedAtMs: number;
}

/** Overflow recovery is a substage of the originating prompt operation, never its own operation. */
export type HarnessAttemptReason = "initial" | "context_overflow_recovery";

export interface HarnessAttemptRef {
	readonly operationId: string;
	readonly attemptId: string;
	readonly index: number;
	readonly reason: HarnessAttemptReason;
	readonly startedAtMs: number;
}

export type HarnessAttemptOutcome = "completed" | "failed" | "aborted" | "overflow";

/** Reducer-side record of a finished attempt; carries no wall-clock data beyond what the attempt ref captured. */
export interface HarnessSettledAttempt {
	readonly attempt: HarnessAttemptRef;
	readonly outcome: HarnessAttemptOutcome;
}

/** Public attempt summary rendered by the controller from settled records plus its own clock readings. */
export interface HarnessAttemptSummary {
	readonly attemptId: string;
	readonly index: number;
	readonly reason: HarnessAttemptReason;
	readonly outcome: HarnessAttemptOutcome;
	readonly startedAtMs: number;
	readonly finishedAtMs: number;
}

export type HarnessOperationOutcome =
	| { readonly status: "completed" }
	| { readonly status: "failed"; readonly code: string; readonly message: string }
	| { readonly status: "aborted"; readonly reason?: string }
	| { readonly status: "cancelled"; readonly reason: string };

export type HarnessLifecycleState =
	| { readonly tag: "idle"; readonly lastSequence: number }
	| {
			readonly tag: "active";
			readonly operation: HarnessOperationRef;
			readonly stage: HarnessOperationStage;
			readonly attempt?: HarnessAttemptRef;
			readonly attempts: readonly HarnessSettledAttempt[];
			readonly abortRequested: boolean;
	  }
	| {
			readonly tag: "settling";
			readonly operation: HarnessOperationRef;
			readonly outcome: HarnessOperationOutcome;
			readonly attempts: readonly HarnessSettledAttempt[];
			readonly abortRequested: boolean;
	  };

export type HarnessLifecycleCommand =
	| { readonly type: "begin"; readonly operation: HarnessOperationRef }
	| { readonly type: "stage"; readonly operationId: string; readonly stage: HarnessOperationStage }
	| { readonly type: "attempt_begin"; readonly attempt: HarnessAttemptRef }
	| { readonly type: "attempt_end"; readonly attemptId: string; readonly outcome: HarnessAttemptOutcome }
	| { readonly type: "abort_request"; readonly operationId: string }
	| { readonly type: "settle_begin"; readonly operationId: string; readonly outcome: HarnessOperationOutcome }
	| { readonly type: "settle_finish"; readonly operationId: string };

export type HarnessLifecycleViolationCode =
	| "busy"
	| "stale_operation"
	| "invalid_transition"
	| "attempt_mismatch"
	| "sequence_violation";

/**
 * Illegal lifecycle transition rejected by the reducer. Extends `Error` so the
 * controller can attach it as a preserved `cause` on public boundary errors.
 */
export class HarnessLifecycleViolation extends Error {
	public readonly code: HarnessLifecycleViolationCode;
	public readonly state: HarnessLifecycleState;
	public readonly command: HarnessLifecycleCommand;

	constructor(
		code: HarnessLifecycleViolationCode,
		message: string,
		state: HarnessLifecycleState,
		command: HarnessLifecycleCommand,
	) {
		super(message);
		this.name = "HarnessLifecycleViolation";
		this.code = code;
		this.state = state;
		this.command = command;
	}
}

export type HarnessLifecycleResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: HarnessLifecycleViolation };

/** Clock and identity factories injected so lifecycle behavior is deterministic under test. */
export interface HarnessLifecycleDependencies {
	readonly createOperationId: () => string;
	readonly now: () => number;
}
