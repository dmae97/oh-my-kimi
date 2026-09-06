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
 * The single classification source for a failed operation: `flush > body`.
 *
 * Session persistence outranks the body because a flush failure after a provider
 * success must never record or report a completed operation, and a flush error
 * that already carries a harness classification (e.g. an `invalid_state`
 * coordinator reentry) keeps it. Both the recorded outcome and the public
 * rejection read their top-level code from here, so the two can never disagree.
 * Settlement is not a source: it runs after the outcome is recorded, so it can
 * only add a cause and a rejection.
 */
function classificationSource(input: {
	readonly bodyError: unknown;
	readonly flushError: unknown;
	readonly fallbackCode: AgentHarnessError["code"];
}):
	| { readonly stage: "body" | "flush"; readonly error: unknown; readonly fallbackCode: AgentHarnessError["code"] }
	| undefined {
	if (input.flushError !== undefined) return { stage: "flush", error: input.flushError, fallbackCode: "session" };
	if (input.bodyError !== undefined) {
		return { stage: "body", error: input.bodyError, fallbackCode: input.fallbackCode };
	}
	return undefined;
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
	const source = classificationSource(input);
	if (source !== undefined) {
		// Only a body failure can be an abort; a flush or settle failure is a failure
		// even when the abort signal happens to be up.
		if (source.stage === "body" && isExplicitAbortError(source.error)) return { status: "aborted" };
		const error = normalizeHarnessError(source.error, source.fallbackCode);
		return { status: "failed", code: error.code, message: error.message };
	}
	return (
		input.classifyResult?.(input.result as T) ??
		(input.signalAborted ? { status: "aborted" } : { status: "completed" })
	);
}

/**
 * Run boundary steps in order and collect their errors instead of stopping at
 * the first. A boundary that must still report, flush, or settle after one step
 * fails uses this so one failure cannot strand the rest.
 */
export async function collectStepErrors(steps: ReadonlyArray<() => Promise<void> | void>): Promise<Error[]> {
	const errors: Error[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			errors.push(toError(error));
		}
	}
	return errors;
}

/**
 * Which error a public operation rejects with, or `undefined` on success.
 *
 * The top-level code comes from the same `flush > body` source the recorded
 * outcome uses, so `outcome.code === rejection.code` for every failed outcome;
 * settlement only ever contributes a cause. Every concurrent cause stays
 * reachable through one `AggregateError` in body, flush, settle order, so an
 * audit can still see that, say, the body and the final flush failed together.
 */
export function resolveOperationFailure(input: {
	readonly bodyError: unknown;
	readonly flushError: unknown;
	readonly settleError: unknown;
	readonly fallbackCode: AgentHarnessError["code"];
}): AgentHarnessError | undefined {
	const causes = [input.bodyError, input.flushError, input.settleError].filter((error) => error !== undefined);
	if (causes.length === 0) return undefined;
	const source = classificationSource(input) ?? {
		stage: "settle" as const,
		error: input.settleError,
		fallbackCode: "hook" as const,
	};
	const code = normalizeHarnessError(source.error, source.fallbackCode).code;
	if (causes.length === 1) return normalizeHarnessError(causes[0], source.fallbackCode);
	const stages = [
		input.bodyError !== undefined ? "body" : undefined,
		input.flushError !== undefined ? "final flush" : undefined,
		input.settleError !== undefined ? "settlement" : undefined,
	].filter((stage) => stage !== undefined);
	const cause = new AggregateError(causes.map(toError), `Operation failed (${stages.join(", ")})`);
	return new AgentHarnessError(code, cause.message, cause);
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
