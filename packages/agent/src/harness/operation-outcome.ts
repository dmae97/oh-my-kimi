/**
 * Pure outcome classification and error aggregation for harness operations.
 *
 * Everything here is a total function over already-observed results: it never
 * touches lifecycle state, sessions, providers, or clocks. Keeping the rules in
 * one leaf module makes the precedence auditable in isolation and keeps
 * `agent-harness.ts` free of the branch-heavy classification tables.
 */

import { type AssistantMessage, isContextOverflow } from "omk-ai";
import type { HarnessAttemptOutcome, HarnessOperationOutcome } from "./operation-lifecycle-types.ts";
import type { NavigateTreeResult } from "./types.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError, toError } from "./types.ts";

/**
 * True only for an error that *is* an abort, not merely an error raised while
 * an abort signal happened to be up. `AgentHarnessError` has no "aborted" code,
 * so an explicit abort reaches us as a subsystem error carrying code "aborted"
 * or as a DOM-style `AbortError`.
 */
export function isExplicitAbortError(error: unknown): boolean {
	const cause = toError(error);
	if (cause.name === "AbortError") return true;
	return (cause instanceof CompactionError || cause instanceof BranchSummaryError) && cause.code === "aborted";
}

/** Map a subsystem failure onto the harness' stable top-level classification. */
export function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

/** Result-based outcome for prompt-family operations that resolve with a failure/abort assistant message. */
export function classifyAssistantOutcome(message: AssistantMessage): HarnessOperationOutcome | undefined {
	if (message.stopReason === "aborted") return { status: "aborted" };
	if (message.stopReason === "error") {
		return { status: "failed", code: "provider", message: message.errorMessage ?? "Provider error" };
	}
	return undefined;
}

/** Structural cancellation is a distinct, non-failure terminal outcome. */
export function classifyNavigateTreeOutcome(result: NavigateTreeResult): HarnessOperationOutcome {
	return result.cancelled ? { status: "cancelled", reason: "tree_navigation_cancelled" } : { status: "completed" };
}

/** A thrown attempt body is an aborted attempt only when the error itself is an abort. */
export function classifyAttemptFailure(error: unknown): HarnessAttemptOutcome {
	return isExplicitAbortError(error) ? "aborted" : "failed";
}

/** Context overflow is a recoverable attempt outcome, not an attempt failure. */
export function classifyAttemptOutcome(
	message: AssistantMessage,
	contextWindow: number | undefined,
): HarnessAttemptOutcome {
	if (message.stopReason === "aborted") return "aborted";
	if (isContextOverflow(message, contextWindow)) return "overflow";
	if (message.stopReason === "error") return "failed";
	return "completed";
}

/**
 * Single outcome-precedence rule for every public operation:
 *
 *   session persistence failure > non-abort body/hook failure >
 *   explicit abort > result-classified outcome > completed
 *
 * A raised abort signal alone never downgrades another failure to "aborted":
 * only an error that *is* an abort does. Otherwise a flush failure during an
 * aborted turn would settle as "aborted" while the public promise rejected
 * with "session".
 */
export function resolveOperationOutcome<T>(input: {
	readonly signalAborted: boolean;
	readonly result: T | undefined;
	readonly bodyError: unknown;
	readonly flushError: unknown;
	readonly classifyResult: ((result: T) => HarnessOperationOutcome | undefined) | undefined;
	readonly fallbackCode: AgentHarnessError["code"];
}): HarnessOperationOutcome {
	if (input.flushError !== undefined) {
		// Mirror `resolveOperationFailure`: a flush error that already carries a
		// harness classification (e.g. an `invalid_state` coordinator reentry)
		// keeps it, so the recorded outcome and the rejection never disagree.
		const error = normalizeHarnessError(input.flushError, "session");
		return { status: "failed", code: error.code, message: error.message };
	}
	if (input.bodyError !== undefined) {
		if (isExplicitAbortError(input.bodyError)) return { status: "aborted" };
		const error = normalizeHarnessError(input.bodyError, input.fallbackCode);
		return { status: "failed", code: error.code, message: error.message };
	}
	return (
		input.classifyResult?.(input.result as T) ??
		(input.signalAborted ? { status: "aborted" } : { status: "completed" })
	);
}

/**
 * The error a boundary should throw after several steps may have failed, or
 * `undefined` when none did. A single failure is returned untouched so its
 * own classification survives; several are kept reachable through one
 * `AggregateError`, classified by the first (primary) failure. This is what
 * lets a failing boundary flush report *alongside* the body or listener error
 * it followed instead of erasing it.
 */
export function combineBoundaryErrors(
	errors: readonly unknown[],
	message: string,
	fallbackCode: AgentHarnessError["code"],
): unknown {
	const present = errors.filter((error) => error !== undefined);
	if (present.length <= 1) return present[0];
	const cause = new AggregateError(present.map(toError), message);
	return new AgentHarnessError(normalizeHarnessError(present[0], fallbackCode).code, cause.message, cause);
}

/**
 * Which error a public operation rejects with, or `undefined` on success.
 *
 * Mirrors the outcome precedence, but every concurrent cause is preserved in an
 * `AggregateError` so an audit can still see that, say, the body and the final
 * flush failed together.
 */
export function resolveOperationFailure(input: {
	readonly bodyError: unknown;
	readonly flushError: unknown;
	readonly settleError: unknown;
	readonly fallbackCode: AgentHarnessError["code"];
}): AgentHarnessError | undefined {
	const primaryError = input.bodyError ?? input.flushError;
	if (primaryError !== undefined && input.settleError !== undefined) {
		const cause = new AggregateError(
			[toError(primaryError), toError(input.settleError)],
			"Operation failed and settlement failed",
		);
		return new AgentHarnessError(normalizeHarnessError(primaryError, input.fallbackCode).code, cause.message, cause);
	}
	if (input.settleError !== undefined) return normalizeHarnessError(input.settleError, "hook");
	if (input.flushError !== undefined) {
		if (input.bodyError === undefined) return normalizeHarnessError(input.flushError, "session");
		const cause = new AggregateError(
			[toError(input.bodyError), toError(input.flushError)],
			"Operation failed and the final flush failed",
		);
		return new AgentHarnessError("session", cause.message, cause);
	}
	if (input.bodyError !== undefined) return normalizeHarnessError(input.bodyError, input.fallbackCode);
	return undefined;
}
