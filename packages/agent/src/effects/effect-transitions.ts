/**
 * Legal phase moves for one effect. Pure and total: every command either
 * yields the next phase (plus the reason code the journal should record) or a
 * classified violation, and nothing here touches the chain, a clock, or I/O.
 *
 * The table encodes the two rules the plan refuses to compromise on:
 *
 * - `commit_unknown` is only ever left by inspection, compensation, an
 *   explicit abandonment, or — for `pure`/`idempotent` semantics alone — a
 *   replay. An `opaque`, `inspectable`, or `compensatable` effect whose commit
 *   is unknown cannot be re-dispatched (`unsafe_replay`).
 * - Terminal phases are final. An acknowledged effect cannot be reopened, so a
 *   late duplicate observation after recovery cannot resurrect it.
 */

import {
	type EffectCommand,
	type EffectJournalResult,
	EffectJournalViolation,
	type EffectPhase,
	type EffectRecord,
	type EffectSemantics,
	TERMINAL_EFFECT_PHASES,
} from "./effect-types.ts";

export interface EffectPhaseMove {
	readonly phase: EffectPhase;
	readonly reasonCode: string;
}

type MoveResult = EffectJournalResult<EffectPhaseMove>;

const REPLAY_SAFE_SEMANTICS: readonly EffectSemantics[] = ["pure", "idempotent"];

export function isTerminalEffectPhase(phase: EffectPhase): boolean {
	return TERMINAL_EFFECT_PHASES.includes(phase);
}

export function isReplaySafe(semantics: EffectSemantics): boolean {
	return REPLAY_SAFE_SEMANTICS.includes(semantics);
}

function move(phase: EffectPhase, reasonCode: string): MoveResult {
	return { ok: true, value: { phase, reasonCode } };
}

function invalid(record: EffectRecord, command: EffectCommand): MoveResult {
	return {
		ok: false,
		error: new EffectJournalViolation(
			"invalid_transition",
			`Effect ${record.effectId} cannot ${command.type} from phase ${record.phase}`,
			record.effectId,
		),
	};
}

function reduceObserve(record: EffectRecord, command: Extract<EffectCommand, { type: "observe" }>): MoveResult {
	if (record.phase !== "dispatched") return invalid(record, command);
	switch (command.observation) {
		case "committed":
			return move("observed_committed", command.reasonCode ?? "effect.observed_committed");
		case "not_committed":
			return move("observed_not_committed", command.reasonCode ?? "effect.observed_not_committed");
		case "unknown":
			return move("commit_unknown", command.reasonCode ?? "effect.commit_unknown");
	}
}

function reduceRedispatch(record: EffectRecord, command: Extract<EffectCommand, { type: "redispatch" }>): MoveResult {
	if (record.phase === "observed_not_committed") return move("dispatched", "effect.retry_not_committed");
	if (record.phase !== "commit_unknown") return invalid(record, command);
	if (isReplaySafe(record.semantics)) return move("dispatched", "effect.replay_safe");
	return {
		ok: false,
		error: new EffectJournalViolation(
			"unsafe_replay",
			`Effect ${record.effectId} has ${record.semantics} semantics and an unknown commit; blind replay is forbidden`,
			record.effectId,
		),
	};
}

function reduceCompensateBegin(
	record: EffectRecord,
	command: Extract<EffectCommand, { type: "compensate_begin" }>,
): MoveResult {
	if (record.phase !== "observed_committed" && record.phase !== "commit_unknown") return invalid(record, command);
	if (record.compensationDescriptor === undefined) {
		return {
			ok: false,
			error: new EffectJournalViolation(
				"missing_descriptor",
				`Effect ${record.effectId} declares no compensation descriptor`,
				record.effectId,
			),
		};
	}
	return move("compensating", "effect.compensation_started");
}

/** Abandonment is an explicit decision (waiver or operator) and must carry its reason. */
function reduceAbandon(record: EffectRecord, command: Extract<EffectCommand, { type: "abandon" }>): MoveResult {
	const allowed: readonly EffectPhase[] = ["prepared", "observed_not_committed", "commit_unknown", "compensating"];
	if (!allowed.includes(record.phase)) return invalid(record, command);
	if (command.reasonCode.trim().length === 0) {
		return {
			ok: false,
			error: new EffectJournalViolation(
				"invalid_record",
				`Abandoning effect ${record.effectId} requires a reason code`,
				record.effectId,
			),
		};
	}
	return move("abandoned", command.reasonCode);
}

/**
 * Every phase the effect may legally move to next, derived from the same
 * rules as `reduceEffectPhase`. Replaying a persisted journal uses this to
 * validate a stored record without reconstructing the command that made it.
 */
export function legalNextPhases(record: EffectRecord): readonly EffectPhase[] {
	switch (record.phase) {
		case "prepared":
			return ["dispatched", "abandoned"];
		case "dispatched":
			return ["observed_committed", "observed_not_committed", "commit_unknown"];
		case "observed_committed":
			return record.compensationDescriptor === undefined ? ["acknowledged"] : ["acknowledged", "compensating"];
		case "observed_not_committed":
			return ["dispatched", "abandoned"];
		case "commit_unknown": {
			const phases: EffectPhase[] = ["observed_committed", "observed_not_committed", "abandoned"];
			if (record.compensationDescriptor !== undefined) phases.push("compensating");
			if (isReplaySafe(record.semantics)) phases.push("dispatched");
			return phases;
		}
		case "compensating":
			return ["compensated", "commit_unknown", "abandoned"];
		case "acknowledged":
		case "compensated":
		case "abandoned":
			return [];
	}
}

/** Next phase for `command` applied to the effect's latest record. */
export function reduceEffectPhase(
	record: EffectRecord,
	command: Exclude<EffectCommand, { type: "prepare" }>,
): MoveResult {
	if (isTerminalEffectPhase(record.phase)) return invalid(record, command);
	switch (command.type) {
		case "dispatch":
			return record.phase === "prepared" ? move("dispatched", "effect.dispatched") : invalid(record, command);
		case "observe":
			return reduceObserve(record, command);
		case "acknowledge":
			return record.phase === "observed_committed"
				? move("acknowledged", "effect.acknowledged")
				: invalid(record, command);
		case "resolve_unknown":
			if (record.phase !== "commit_unknown") return invalid(record, command);
			return command.inspection === "committed"
				? move("observed_committed", "effect.inspection_committed")
				: move("observed_not_committed", "effect.inspection_not_committed");
		case "redispatch":
			return reduceRedispatch(record, command);
		case "compensate_begin":
			return reduceCompensateBegin(record, command);
		case "compensate_end":
			if (record.phase !== "compensating") return invalid(record, command);
			return command.result === "compensated"
				? move("compensated", "effect.compensated")
				: move("commit_unknown", "effect.compensation_unknown");
		case "abandon":
			return reduceAbandon(record, command);
		default: {
			const unknownCommand: never = command;
			throw new EffectJournalViolation("invalid_transition", `Unknown effect command ${String(unknownCommand)}`);
		}
	}
}
