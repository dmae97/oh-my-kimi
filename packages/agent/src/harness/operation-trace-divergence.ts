/**
 * Trace comparison for shadow-mode runtime convergence (FND-003, Stage C).
 *
 * While `AgentHarness` runs as a shadow reducer beside the authoritative
 * `AgentSession`, every scenario yields two traces. This module reduces each
 * trace to a per-operation summary and classifies every difference as a
 * `blocker` (the two runtimes disagree about lifecycle semantics) or a
 * `non_blocker` (they took a different path to the same committed state).
 *
 * Blocker dimensions follow the plan verbatim: operation count and identity,
 * the attempt set and how each attempt closed, terminal status and public
 * error code, accepted deferred-command IDs in order, session-write order,
 * and effect uncertainty left open at settlement. Stage paths and abort
 * signalling without an outcome difference are informational only.
 */

import { computeTraceDigest, type OperationTraceEvent, type TraceOutcome } from "./operation-trace.ts";

export type TraceDivergenceClass = "blocker" | "non_blocker";

export type TraceDivergenceDimension =
	| "operation_count"
	| "operation_identity"
	| "attempt_set"
	| "terminal_status"
	| "public_error_code"
	| "accepted_commands"
	| "session_write_order"
	| "effect_uncertainty"
	| "stage_path"
	| "abort_signal";

const BLOCKER_DIMENSIONS: ReadonlySet<TraceDivergenceDimension> = new Set([
	"operation_count",
	"operation_identity",
	"attempt_set",
	"terminal_status",
	"public_error_code",
	"accepted_commands",
	"session_write_order",
	"effect_uncertainty",
]);

export interface TraceDivergence {
	readonly dimension: TraceDivergenceDimension;
	readonly class: TraceDivergenceClass;
	readonly operationIndex?: number;
	readonly left: string;
	readonly right: string;
}

export interface TraceComparison {
	readonly equal: boolean;
	readonly leftDigest: string;
	readonly rightDigest: string;
	readonly blockers: readonly TraceDivergence[];
	readonly nonBlockers: readonly TraceDivergence[];
}

export interface TraceAttemptSummary {
	readonly attemptId: string;
	readonly index: number;
	readonly reason: string;
	readonly outcome?: string;
}

/** Everything the comparison reads about one operation, in source order. */
export interface OperationTraceSummary {
	readonly operationId: string;
	readonly kind: string;
	readonly sequence: number;
	readonly stages: readonly string[];
	readonly attempts: readonly TraceAttemptSummary[];
	readonly abortRequested: boolean;
	readonly settlement?: TraceOutcome;
	readonly settled?: TraceOutcome;
	/** Effects marked uncertain and not reconciled before the operation settled. */
	readonly unresolvedEffectIds: readonly string[];
}

export interface TraceSummary {
	readonly operations: readonly OperationTraceSummary[];
	readonly acceptedCommandIds: readonly string[];
	readonly sessionWrites: readonly string[];
}

interface MutableOperation {
	operationId: string;
	kind: string;
	sequence: number;
	stages: string[];
	attempts: TraceAttemptSummary[];
	abortRequested: boolean;
	settlement?: TraceOutcome;
	settled?: TraceOutcome;
	unresolved: Set<string>;
}

export function summarizeTrace(events: readonly OperationTraceEvent[]): TraceSummary {
	const operations: MutableOperation[] = [];
	const byId = new Map<string, MutableOperation>();
	const acceptedCommandIds: string[] = [];
	const sessionWrites: string[] = [];
	for (const event of events) {
		switch (event.type) {
			case "operation_started": {
				const operation: MutableOperation = {
					operationId: event.operationId,
					kind: event.kind,
					sequence: event.sequence,
					stages: [],
					attempts: [],
					abortRequested: false,
					unresolved: new Set(),
				};
				operations.push(operation);
				byId.set(event.operationId, operation);
				break;
			}
			case "stage_changed":
				byId.get(event.operationId)?.stages.push(event.stage);
				break;
			case "attempt_started":
				byId
					.get(event.operationId)
					?.attempts.push({ attemptId: event.attemptId, index: event.index, reason: event.reason });
				break;
			case "attempt_finished": {
				const operation = byId.get(event.operationId);
				if (operation === undefined) break;
				operation.attempts = operation.attempts.map((attempt) =>
					attempt.attemptId === event.attemptId ? { ...attempt, outcome: event.outcome } : attempt,
				);
				break;
			}
			case "abort_requested": {
				const operation = byId.get(event.operationId);
				if (operation !== undefined) operation.abortRequested = true;
				break;
			}
			case "effect_uncertain":
				byId.get(event.operationId)?.unresolved.add(event.effectId);
				break;
			case "effect_reconciled":
				byId.get(event.operationId)?.unresolved.delete(event.effectId);
				break;
			case "effect_prepared":
				break;
			case "deferred_command_accepted":
				acceptedCommandIds.push(event.commandId);
				break;
			case "session_write_accepted":
				sessionWrites.push(`${event.writeSequence}:${event.writeType}`);
				break;
			case "settlement_started": {
				const operation = byId.get(event.operationId);
				if (operation !== undefined) operation.settlement = event.outcome;
				break;
			}
			case "operation_settled": {
				const operation = byId.get(event.operationId);
				if (operation !== undefined) operation.settled = event.outcome;
				break;
			}
			default: {
				const unknownEvent: never = event;
				throw new TypeError(`Unknown trace event ${String((unknownEvent as { type?: unknown }).type)}`);
			}
		}
	}
	return {
		operations: operations.map((operation) => ({
			operationId: operation.operationId,
			kind: operation.kind,
			sequence: operation.sequence,
			stages: operation.stages,
			attempts: operation.attempts,
			abortRequested: operation.abortRequested,
			...(operation.settlement === undefined ? {} : { settlement: operation.settlement }),
			...(operation.settled === undefined ? {} : { settled: operation.settled }),
			unresolvedEffectIds: [...operation.unresolved].sort(compareCodeUnits),
		})),
		acceptedCommandIds,
		sessionWrites,
	};
}

/** Code-unit order, so the report does not depend on the host locale. */
function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function describeOutcome(outcome: TraceOutcome | undefined): string {
	if (outcome === undefined) return "<none>";
	return outcome.status === "failed" ? `failed:${outcome.code}` : outcome.status;
}

function describeAttempts(attempts: readonly TraceAttemptSummary[]): string {
	return attempts.map((attempt) => `${attempt.attemptId}/${attempt.reason}=${attempt.outcome ?? "<open>"}`).join(",");
}

function compareOperation(index: number, left: OperationTraceSummary, right: OperationTraceSummary): TraceDivergence[] {
	const out: TraceDivergence[] = [];
	const push = (dimension: TraceDivergenceDimension, leftValue: string, rightValue: string): void => {
		if (leftValue === rightValue) return;
		const divergenceClass: TraceDivergenceClass = BLOCKER_DIMENSIONS.has(dimension) ? "blocker" : "non_blocker";
		out.push({ dimension, class: divergenceClass, operationIndex: index, left: leftValue, right: rightValue });
	};
	push("operation_identity", `${left.kind}#${left.sequence}`, `${right.kind}#${right.sequence}`);
	push("attempt_set", describeAttempts(left.attempts), describeAttempts(right.attempts));
	const leftSettled = left.settled ?? left.settlement;
	const rightSettled = right.settled ?? right.settlement;
	if ((leftSettled?.status ?? "<none>") !== (rightSettled?.status ?? "<none>")) {
		out.push({
			dimension: "terminal_status",
			class: "blocker",
			operationIndex: index,
			left: describeOutcome(leftSettled),
			right: describeOutcome(rightSettled),
		});
	} else if (leftSettled?.status === "failed" && rightSettled?.status === "failed") {
		push("public_error_code", leftSettled.code, rightSettled.code);
	}
	push("effect_uncertainty", left.unresolvedEffectIds.join(","), right.unresolvedEffectIds.join(","));
	push("stage_path", left.stages.join(">"), right.stages.join(">"));
	push("abort_signal", String(left.abortRequested), String(right.abortRequested));
	return out;
}

/** Compare two traces of the same scenario. Equal digests short-circuit to an empty report. */
export function compareOperationTraces(
	left: readonly OperationTraceEvent[],
	right: readonly OperationTraceEvent[],
): TraceComparison {
	const leftDigest = computeTraceDigest(left);
	const rightDigest = computeTraceDigest(right);
	if (leftDigest === rightDigest) return { equal: true, leftDigest, rightDigest, blockers: [], nonBlockers: [] };
	const leftSummary = summarizeTrace(left);
	const rightSummary = summarizeTrace(right);
	const divergences: TraceDivergence[] = [];
	if (leftSummary.operations.length !== rightSummary.operations.length) {
		divergences.push({
			dimension: "operation_count",
			class: "blocker",
			left: String(leftSummary.operations.length),
			right: String(rightSummary.operations.length),
		});
	}
	const shared = Math.min(leftSummary.operations.length, rightSummary.operations.length);
	for (let index = 0; index < shared; index++) {
		divergences.push(...compareOperation(index, leftSummary.operations[index], rightSummary.operations[index]));
	}
	const leftCommands = leftSummary.acceptedCommandIds.join(",");
	const rightCommands = rightSummary.acceptedCommandIds.join(",");
	if (leftCommands !== rightCommands) {
		divergences.push({ dimension: "accepted_commands", class: "blocker", left: leftCommands, right: rightCommands });
	}
	const leftWrites = leftSummary.sessionWrites.join(",");
	const rightWrites = rightSummary.sessionWrites.join(",");
	if (leftWrites !== rightWrites) {
		divergences.push({ dimension: "session_write_order", class: "blocker", left: leftWrites, right: rightWrites });
	}
	return {
		equal: false,
		leftDigest,
		rightDigest,
		blockers: divergences.filter((item) => item.class === "blocker"),
		nonBlockers: divergences.filter((item) => item.class === "non_blocker"),
	};
}
