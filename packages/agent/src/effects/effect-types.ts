/**
 * Effect Journal V2 vocabulary: the durable identity and phase model for every
 * side effect a harness operation performs.
 *
 * A side effect is not a tool result. The tool result says what the tool
 * reported; the effect record says what the runtime committed to before,
 * during, and after the action, so that after a crash the question "did it
 * happen?" has one of three honest answers — committed, not committed, or
 * unknown — instead of being overwritten by a retry.
 *
 * This module imports nothing and declares no behaviour. Legal phase moves
 * live in `effect-transitions.ts`, the hash-chained journal in
 * `effect-journal.ts`, recovery in `effect-recovery.ts`.
 */

export const EFFECT_RECORD_SCHEMA_VERSION = 2 as const;

/** The hash a journal's first record chains to. */
export const EFFECT_JOURNAL_GENESIS_HASH = "0".repeat(64);

/**
 * What the runtime may assume about re-executing the effect.
 *
 * | semantics       | automatic recovery                                |
 * | --------------- | ------------------------------------------------- |
 * | `pure`          | re-execute freely                                 |
 * | `idempotent`    | re-execute with the same idempotency key           |
 * | `inspectable`   | inspect the target, then decide                   |
 * | `compensatable` | run the declared compensation                     |
 * | `opaque`        | never re-execute automatically; operator decides  |
 */
export type EffectSemantics = "pure" | "idempotent" | "inspectable" | "compensatable" | "opaque";

export type EffectPhase =
	| "prepared"
	| "dispatched"
	| "observed_committed"
	| "observed_not_committed"
	| "commit_unknown"
	| "acknowledged"
	| "compensating"
	| "compensated"
	| "abandoned";

/** Phases after which the journal accepts no further transition for the effect. */
export const TERMINAL_EFFECT_PHASES: readonly EffectPhase[] = ["acknowledged", "compensated", "abandoned"];

/** Phases whose external outcome is not yet known; a verified verdict needs this set empty. */
export const UNCERTAIN_EFFECT_PHASES: readonly EffectPhase[] = ["dispatched", "commit_unknown", "compensating"];

export interface EffectInspectionDescriptor {
	readonly kind: string;
	readonly targetDigest?: string;
	readonly parameters?: Readonly<Record<string, string>>;
}

export interface EffectCompensationDescriptor {
	readonly kind: string;
	readonly parameters?: Readonly<Record<string, string>>;
}

/** Who performs the effect, under which operation, attempt, lane epoch, and process incarnation. */
export interface EffectIdentity {
	readonly effectId: string;
	readonly operationId: string;
	readonly attemptId: string;
	readonly laneId?: string;
	readonly laneEpoch?: number;
	readonly processIncarnation: string;
}

/** What the effect intends to do, committed before dispatch and constant for the effect's lifetime. */
export interface EffectIntent {
	readonly semantics: EffectSemantics;
	readonly capabilityDigest: string;
	readonly intentDigest: string;
	readonly idempotencyKey?: string;
	readonly inspectDescriptor?: EffectInspectionDescriptor;
	readonly compensationDescriptor?: EffectCompensationDescriptor;
}

/** One hash-chained journal entry: the effect's identity, intent, and phase at `sequence`. */
export interface EffectRecord extends EffectIdentity, EffectIntent {
	readonly schemaVersion: typeof EFFECT_RECORD_SCHEMA_VERSION;
	readonly phase: EffectPhase;
	readonly sequence: number;
	readonly timestamp: string;
	readonly reasonCode?: string;
	readonly previousRecordHash: string;
	readonly recordHash: string;
}

export type EffectObservation = "committed" | "not_committed" | "unknown";

export type EffectCommand =
	| {
			readonly type: "prepare";
			readonly identity: EffectIdentity;
			readonly intent: EffectIntent;
			readonly timestamp: string;
	  }
	| { readonly type: "dispatch"; readonly effectId: string; readonly timestamp: string }
	| {
			readonly type: "observe";
			readonly effectId: string;
			readonly observation: EffectObservation;
			readonly timestamp: string;
			readonly reasonCode?: string;
	  }
	| { readonly type: "acknowledge"; readonly effectId: string; readonly timestamp: string }
	| {
			readonly type: "resolve_unknown";
			readonly effectId: string;
			readonly inspection: "committed" | "not_committed";
			readonly timestamp: string;
	  }
	| { readonly type: "redispatch"; readonly effectId: string; readonly timestamp: string }
	| { readonly type: "compensate_begin"; readonly effectId: string; readonly timestamp: string }
	| {
			readonly type: "compensate_end";
			readonly effectId: string;
			readonly result: "compensated" | "unknown";
			readonly timestamp: string;
	  }
	| { readonly type: "abandon"; readonly effectId: string; readonly reasonCode: string; readonly timestamp: string };

export type EffectViolationCode =
	| "unknown_effect"
	| "duplicate_effect"
	| "invalid_transition"
	| "unsafe_replay"
	| "missing_descriptor"
	| "identity_mismatch"
	| "sequence_violation"
	| "chain_break"
	| "hash_mismatch"
	| "invalid_record";

export class EffectJournalViolation extends Error {
	public readonly code: EffectViolationCode;
	public readonly effectId?: string;

	constructor(code: EffectViolationCode, message: string, effectId?: string) {
		super(message);
		this.name = "EffectJournalViolation";
		this.code = code;
		this.effectId = effectId;
	}
}

export type EffectJournalResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: EffectJournalViolation };

/** Latest record per effect plus the chain head; the whole thing is plain data. */
export interface EffectJournalState {
	readonly headHash: string;
	readonly lastSequence: number;
	readonly effects: Readonly<Record<string, EffectRecord>>;
}
