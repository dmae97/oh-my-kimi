/**
 * Hash-chained effect journal reducer.
 *
 * Two entry points, one invariant. `reduceEffectJournal` is the write path:
 * it turns a command into the next record — sequence, previous hash, and
 * record hash all derived, never supplied — and refuses illegal moves.
 * `appendEffectRecord` is the read/replay path: it re-verifies a persisted
 * record against the same rules plus the chain, so a journal that was
 * tampered with, truncated in the middle, or produced by a reducer with a
 * different transition table fails to replay instead of silently loading.
 *
 * The state is plain data: the head hash, the last sequence, and the latest
 * record per effect. It is a pure fold over the record list, so recovery
 * cost is linear in journal length and replaying twice yields equal states.
 */

import { canonicalDigest, domainDigest } from "../harness/canonical-digest.ts";
import { legalNextPhases, reduceEffectPhase } from "./effect-transitions.ts";
import {
	EFFECT_JOURNAL_GENESIS_HASH,
	EFFECT_RECORD_SCHEMA_VERSION,
	type EffectCommand,
	type EffectIdentity,
	type EffectIntent,
	type EffectJournalResult,
	type EffectJournalState,
	EffectJournalViolation,
	type EffectRecord,
	type EffectSemantics,
} from "./effect-types.ts";

export const EFFECT_ID_DOMAIN = "omk.effect.v2";
export const EFFECT_RECORD_DOMAIN = "omk.effect.record.v2";

const SEMANTICS: readonly EffectSemantics[] = ["pure", "idempotent", "inspectable", "compensatable", "opaque"];

export interface EffectIdInput {
	readonly operationId: string;
	/** Logical attempt index of the action. A provider retry that keeps the same logical action keeps this. */
	readonly attemptLogicalIndex: number;
	readonly toolCallId: string;
	readonly intentDigest: string;
	/** Explicit resume token; without one, a different logical index yields a different effect. */
	readonly resumeToken?: string;
}

/** Stable effect identity per plan §6.5. Two logically distinct actions never share an id. */
export function deriveEffectId(input: EffectIdInput): string {
	const attemptPart =
		input.resumeToken === undefined ? `index:${input.attemptLogicalIndex}` : `resume:${input.resumeToken}`;
	return domainDigest(EFFECT_ID_DOMAIN, [input.operationId, attemptPart, input.toolCallId, input.intentDigest]);
}

export function initialEffectJournalState(): EffectJournalState {
	return { headHash: EFFECT_JOURNAL_GENESIS_HASH, lastSequence: 0, effects: {} };
}

export function computeEffectRecordHash(record: Omit<EffectRecord, "recordHash">): string {
	return canonicalDigest({ domain: EFFECT_RECORD_DOMAIN, record });
}

export function lookupEffect(state: EffectJournalState, effectId: string): EffectRecord | undefined {
	return Object.hasOwn(state.effects, effectId) ? state.effects[effectId] : undefined;
}

function fail<T>(code: EffectJournalViolation["code"], message: string, effectId?: string): EffectJournalResult<T> {
	return { ok: false, error: new EffectJournalViolation(code, message, effectId) };
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validatePrepare(identity: EffectIdentity, intent: EffectIntent, timestamp: string): string | undefined {
	for (const [name, value] of [
		["effectId", identity.effectId],
		["operationId", identity.operationId],
		["attemptId", identity.attemptId],
		["processIncarnation", identity.processIncarnation],
		["capabilityDigest", intent.capabilityDigest],
		["intentDigest", intent.intentDigest],
		["timestamp", timestamp],
	] as const) {
		if (!nonEmpty(value)) return `${name} must be a non-empty string`;
	}
	if (!SEMANTICS.includes(intent.semantics)) return `unknown semantics ${String(intent.semantics)}`;
	if (intent.semantics === "idempotent" && !nonEmpty(intent.idempotencyKey)) {
		return "idempotent effects require an idempotencyKey";
	}
	if (intent.semantics === "compensatable" && intent.compensationDescriptor === undefined) {
		return "compensatable effects require a compensationDescriptor";
	}
	if (intent.semantics === "inspectable" && intent.inspectDescriptor === undefined) {
		return "inspectable effects require an inspectDescriptor";
	}
	if (identity.laneEpoch !== undefined && (!Number.isInteger(identity.laneEpoch) || identity.laneEpoch < 0)) {
		return "laneEpoch must be a non-negative integer";
	}
	return undefined;
}

function seal(state: EffectJournalState, body: Omit<EffectRecord, "recordHash" | "sequence" | "previousRecordHash">) {
	const unsealed = { ...body, sequence: state.lastSequence + 1, previousRecordHash: state.headHash };
	const record: EffectRecord = Object.freeze({ ...unsealed, recordHash: computeEffectRecordHash(unsealed) });
	const next: EffectJournalState = Object.freeze({
		headHash: record.recordHash,
		lastSequence: record.sequence,
		effects: Object.freeze({ ...state.effects, [record.effectId]: record }),
	});
	return { ok: true as const, value: { state: next, record } };
}

export interface EffectJournalStep {
	readonly state: EffectJournalState;
	readonly record: EffectRecord;
}

/** Write path: derive and chain the next record for `command`, or reject it. */
export function reduceEffectJournal(
	state: EffectJournalState,
	command: EffectCommand,
): EffectJournalResult<EffectJournalStep> {
	if (command.type === "prepare") {
		const problem = validatePrepare(command.identity, command.intent, command.timestamp);
		if (problem !== undefined) return fail("invalid_record", problem, command.identity.effectId);
		if (lookupEffect(state, command.identity.effectId) !== undefined) {
			return fail(
				"duplicate_effect",
				`Effect ${command.identity.effectId} is already journaled`,
				command.identity.effectId,
			);
		}
		return seal(state, {
			...command.identity,
			...command.intent,
			schemaVersion: EFFECT_RECORD_SCHEMA_VERSION,
			phase: "prepared",
			timestamp: command.timestamp,
			reasonCode: "effect.prepared",
		});
	}
	const latest = lookupEffect(state, command.effectId);
	if (latest === undefined)
		return fail("unknown_effect", `Effect ${command.effectId} is not journaled`, command.effectId);
	if (!nonEmpty(command.timestamp))
		return fail("invalid_record", "timestamp must be a non-empty string", command.effectId);
	const moved = reduceEffectPhase(latest, command);
	if (!moved.ok) return moved;
	const { recordHash: _hash, sequence: _sequence, previousRecordHash: _previous, ...carried } = latest;
	return seal(state, {
		...carried,
		phase: moved.value.phase,
		timestamp: command.timestamp,
		reasonCode: moved.value.reasonCode,
	});
}

const IDENTITY_FIELDS = [
	"operationId",
	"attemptId",
	"laneId",
	"laneEpoch",
	"processIncarnation",
	"semantics",
	"capabilityDigest",
	"intentDigest",
	"idempotencyKey",
] as const;

/** Replay path: verify a persisted record against the chain and the transition table, then apply it. */
export function appendEffectRecord(
	state: EffectJournalState,
	record: EffectRecord,
): EffectJournalResult<EffectJournalState> {
	const id = record.effectId;
	if (record.schemaVersion !== EFFECT_RECORD_SCHEMA_VERSION) {
		return fail("invalid_record", `Unsupported effect record schema ${String(record.schemaVersion)}`, id);
	}
	if (record.sequence !== state.lastSequence + 1) {
		return fail("sequence_violation", `Record sequence ${record.sequence} is not ${state.lastSequence + 1}`, id);
	}
	if (record.previousRecordHash !== state.headHash) {
		return fail(
			"chain_break",
			`Record ${record.sequence} chains to ${record.previousRecordHash}, head is ${state.headHash}`,
			id,
		);
	}
	const { recordHash, ...body } = record;
	if (computeEffectRecordHash(body) !== recordHash) {
		return fail("hash_mismatch", `Record ${record.sequence} hash does not match its contents`, id);
	}
	const latest = lookupEffect(state, id);
	if (latest === undefined) {
		const problem = validatePrepare(record, record, record.timestamp);
		if (problem !== undefined) return fail("invalid_record", problem, id);
		if (record.phase !== "prepared") return fail("invalid_record", `First record for ${id} must be prepared`, id);
	} else {
		for (const field of IDENTITY_FIELDS) {
			if (latest[field] !== record[field]) {
				return fail("identity_mismatch", `Record ${record.sequence} changes ${field} of effect ${id}`, id);
			}
		}
		if (!legalNextPhases(latest).includes(record.phase)) {
			return fail("invalid_transition", `Effect ${id} cannot move ${latest.phase} -> ${record.phase}`, id);
		}
		if (record.phase === "abandoned" && !nonEmpty(record.reasonCode)) {
			return fail("invalid_record", `Abandoned record for ${id} carries no reason code`, id);
		}
	}
	const frozen = Object.freeze({ ...record });
	return {
		ok: true,
		value: Object.freeze({
			headHash: frozen.recordHash,
			lastSequence: frozen.sequence,
			effects: Object.freeze({ ...state.effects, [id]: frozen }),
		}),
	};
}

/** Fold a persisted record list into journal state; the first bad record stops the replay. */
export function replayEffectJournal(records: readonly EffectRecord[]): EffectJournalResult<EffectJournalState> {
	let state = initialEffectJournalState();
	for (const [index, record] of records.entries()) {
		const next = appendEffectRecord(state, record);
		if (!next.ok) {
			const error = new EffectJournalViolation(
				next.error.code,
				`Journal record ${index}: ${next.error.message}`,
				next.error.effectId,
			);
			return { ok: false, error };
		}
		state = next.value;
	}
	return { ok: true, value: state };
}
