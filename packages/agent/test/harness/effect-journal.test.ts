import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	appendEffectRecord,
	computeEffectRecordHash,
	deriveEffectId,
	initialEffectJournalState,
	lookupEffect,
	reduceEffectJournal,
	replayEffectJournal,
} from "../../src/effects/effect-journal.ts";
import {
	computeUncertaintyFrontier,
	decideEffectRecovery,
	frontierBlocksVerified,
	planEffectRecovery,
} from "../../src/effects/effect-recovery.ts";
import { isTerminalEffectPhase, legalNextPhases, reduceEffectPhase } from "../../src/effects/effect-transitions.ts";
import {
	EFFECT_JOURNAL_GENESIS_HASH,
	type EffectCommand,
	type EffectJournalState,
	type EffectPhase,
	type EffectRecord,
	type EffectSemantics,
	TERMINAL_EFFECT_PHASES,
	UNCERTAIN_EFFECT_PHASES,
} from "../../src/effects/effect-types.ts";

const T = "2026-09-04T00:00:00.000Z";
const ALL_PHASES: readonly EffectPhase[] = [
	"prepared",
	"dispatched",
	"observed_committed",
	"observed_not_committed",
	"commit_unknown",
	"acknowledged",
	"compensating",
	"compensated",
	"abandoned",
];
const ALL_SEMANTICS: readonly EffectSemantics[] = ["pure", "idempotent", "inspectable", "compensatable", "opaque"];

function prepareCommand(
	effectId: string,
	semantics: EffectSemantics,
	options: { operationId?: string; withDescriptors?: boolean } = {},
): Extract<EffectCommand, { type: "prepare" }> {
	const withDescriptors = options.withDescriptors ?? true;
	return {
		type: "prepare",
		identity: {
			effectId,
			operationId: options.operationId ?? "op-1",
			attemptId: "op-1:a0",
			processIncarnation: "pid:1:boot:x",
		},
		intent: {
			semantics,
			capabilityDigest: "cap",
			intentDigest: "intent",
			...(semantics === "idempotent" ? { idempotencyKey: "key" } : {}),
			...(withDescriptors && (semantics === "inspectable" || semantics === "compensatable" || semantics === "opaque")
				? { inspectDescriptor: { kind: "digest" }, compensationDescriptor: { kind: "delete" } }
				: {}),
			...(semantics === "compensatable" && !withDescriptors ? { compensationDescriptor: { kind: "delete" } } : {}),
			...(semantics === "inspectable" && !withDescriptors ? { inspectDescriptor: { kind: "digest" } } : {}),
		},
		timestamp: T,
	};
}

/** The journal keeps only the latest record per effect; tests track the full chain per produced state. */
const recordLog = new WeakMap<EffectJournalState, readonly EffectRecord[]>();

function step(state: EffectJournalState, command: EffectCommand): EffectJournalState {
	const result = reduceEffectJournal(state, command);
	if (!result.ok) throw result.error;
	recordLog.set(result.value.state, [...(recordLog.get(state) ?? []), result.value.record]);
	return result.value.state;
}

function collectRecords(state: EffectJournalState): EffectRecord[] {
	const records = recordLog.get(state);
	if (records === undefined) throw new Error("collectRecords: state was not produced through step()");
	return [...records];
}

/** Build a record in an arbitrary phase for transition-table tests. */
function recordIn(phase: EffectPhase, semantics: EffectSemantics, withDescriptors = true): EffectRecord {
	const prepared = reduceEffectJournal(
		initialEffectJournalState(),
		prepareCommand("e", semantics, { withDescriptors }),
	);
	if (!prepared.ok) throw prepared.error;
	return { ...prepared.value.record, phase };
}

function commandsFor(effectId: string): Exclude<EffectCommand, { type: "prepare" }>[] {
	return [
		{ type: "dispatch", effectId, timestamp: T },
		{ type: "observe", effectId, observation: "committed", timestamp: T },
		{ type: "observe", effectId, observation: "not_committed", timestamp: T },
		{ type: "observe", effectId, observation: "unknown", timestamp: T },
		{ type: "acknowledge", effectId, timestamp: T },
		{ type: "resolve_unknown", effectId, inspection: "committed", timestamp: T },
		{ type: "resolve_unknown", effectId, inspection: "not_committed", timestamp: T },
		{ type: "redispatch", effectId, timestamp: T },
		{ type: "compensate_begin", effectId, timestamp: T },
		{ type: "compensate_end", effectId, result: "compensated", timestamp: T },
		{ type: "compensate_end", effectId, result: "unknown", timestamp: T },
		{ type: "abandon", effectId, reasonCode: "waiver:w1", timestamp: T },
	];
}

describe("effect transitions", () => {
	it("reduceEffectPhase and legalNextPhases agree in both directions for every phase and semantics", () => {
		for (const semantics of ALL_SEMANTICS) {
			for (const withDescriptors of [true, false]) {
				for (const phase of ALL_PHASES) {
					const record = recordIn(phase, semantics, withDescriptors);
					const legal = new Set(legalNextPhases(record));
					const reached = new Set<EffectPhase>();
					for (const command of commandsFor("e")) {
						const result = reduceEffectPhase(record, command);
						if (result.ok) {
							expect(legal.has(result.value.phase), `${semantics}/${phase}/${command.type}`).toBe(true);
							reached.add(result.value.phase);
						}
					}
					expect([...reached].sort()).toEqual([...legal].sort());
					if (isTerminalEffectPhase(phase)) expect(legal.size).toBe(0);
				}
			}
		}
	});

	it("forbids blind replay of a non-replay-safe effect with unknown commit", () => {
		for (const semantics of ["inspectable", "compensatable", "opaque"] as const) {
			const result = reduceEffectPhase(recordIn("commit_unknown", semantics), {
				type: "redispatch",
				effectId: "e",
				timestamp: T,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("unsafe_replay");
		}
		for (const semantics of ["pure", "idempotent"] as const) {
			const result = reduceEffectPhase(recordIn("commit_unknown", semantics), {
				type: "redispatch",
				effectId: "e",
				timestamp: T,
			});
			expect(result).toMatchObject({ ok: true, value: { phase: "dispatched", reasonCode: "effect.replay_safe" } });
		}
	});

	it("requires a compensation descriptor to compensate and a reason to abandon", () => {
		const noDescriptor = reduceEffectPhase(recordIn("observed_committed", "pure"), {
			type: "compensate_begin",
			effectId: "e",
			timestamp: T,
		});
		expect(noDescriptor).toMatchObject({ ok: false, error: { code: "missing_descriptor" } });
		const noReason = reduceEffectPhase(recordIn("commit_unknown", "opaque"), {
			type: "abandon",
			effectId: "e",
			reasonCode: "  ",
			timestamp: T,
		});
		expect(noReason).toMatchObject({ ok: false, error: { code: "invalid_record" } });
	});
});

describe("effect journal", () => {
	it("chains records, derives sequence and hashes, and replays to the same state", () => {
		let state = initialEffectJournalState();
		expect(state.headHash).toBe(EFFECT_JOURNAL_GENESIS_HASH);
		state = step(state, prepareCommand("e1", "inspectable"));
		state = step(state, { type: "dispatch", effectId: "e1", timestamp: T });
		state = step(state, { type: "observe", effectId: "e1", observation: "committed", timestamp: T });
		state = step(state, { type: "acknowledge", effectId: "e1", timestamp: T });
		const records = collectRecords(state);
		expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
		expect(records.map((record) => record.phase)).toEqual([
			"prepared",
			"dispatched",
			"observed_committed",
			"acknowledged",
		]);
		expect(records[0].previousRecordHash).toBe(EFFECT_JOURNAL_GENESIS_HASH);
		for (let index = 1; index < records.length; index++) {
			expect(records[index].previousRecordHash).toBe(records[index - 1].recordHash);
		}
		const replayed = replayEffectJournal(records);
		expect(replayed.ok).toBe(true);
		if (replayed.ok) {
			expect(replayed.value.headHash).toBe(state.headHash);
			expect(replayed.value).toEqual(state);
			expect(Object.isFrozen(replayed.value.effects)).toBe(true);
		}
	});

	it("rejects duplicates, unknown effects, malformed intents, and post-terminal commands", () => {
		let state = step(initialEffectJournalState(), prepareCommand("e1", "pure"));
		expect(reduceEffectJournal(state, prepareCommand("e1", "pure"))).toMatchObject({
			ok: false,
			error: { code: "duplicate_effect" },
		});
		expect(reduceEffectJournal(state, { type: "dispatch", effectId: "nope", timestamp: T })).toMatchObject({
			ok: false,
			error: { code: "unknown_effect" },
		});
		const missingKey = prepareCommand("e2", "idempotent");
		expect(
			reduceEffectJournal(state, { ...missingKey, intent: { ...missingKey.intent, idempotencyKey: undefined } }),
		).toMatchObject({ ok: false, error: { code: "invalid_record" } });
		const missingCompensation = prepareCommand("e3", "compensatable");
		expect(
			reduceEffectJournal(state, {
				...missingCompensation,
				intent: { ...missingCompensation.intent, compensationDescriptor: undefined },
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_record" } });
		expect(reduceEffectJournal(state, { type: "dispatch", effectId: "e1", timestamp: "" })).toMatchObject({
			ok: false,
			error: { code: "invalid_record" },
		});
		state = step(state, { type: "dispatch", effectId: "e1", timestamp: T });
		state = step(state, { type: "observe", effectId: "e1", observation: "committed", timestamp: T });
		state = step(state, { type: "acknowledge", effectId: "e1", timestamp: T });
		for (const command of commandsFor("e1")) {
			expect(reduceEffectJournal(state, command)).toMatchObject({
				ok: false,
				error: { code: "invalid_transition" },
			});
		}
	});

	it("detects tampering, truncation, reordering, identity drift, and illegal jumps on replay", () => {
		let state = initialEffectJournalState();
		state = step(state, prepareCommand("e1", "compensatable"));
		state = step(state, { type: "dispatch", effectId: "e1", timestamp: T });
		state = step(state, { type: "observe", effectId: "e1", observation: "unknown", timestamp: T });
		state = step(state, { type: "compensate_begin", effectId: "e1", timestamp: T });
		const records = collectRecords(state);

		const tampered = records.map((record, index) =>
			index === 2 ? { ...record, phase: "observed_committed" as const } : record,
		);
		expect(replayEffectJournal(tampered)).toMatchObject({ ok: false, error: { code: "hash_mismatch" } });

		const dropped = records.filter((_, index) => index !== 1);
		expect(replayEffectJournal(dropped)).toMatchObject({ ok: false, error: { code: "sequence_violation" } });

		const swapped = [records[0], records[2], records[1], records[3]];
		expect(replayEffectJournal(swapped)).toMatchObject({ ok: false, error: { code: "sequence_violation" } });

		const resequenced = records.map((record, index) =>
			index === 2 ? { ...record, sequence: 3, previousRecordHash: "ab".repeat(32) } : record,
		);
		const rehashed = resequenced.map((record) => {
			const { recordHash: _hash, ...body } = record;
			return { ...body, recordHash: computeEffectRecordHash(body) };
		});
		expect(replayEffectJournal(rehashed)).toMatchObject({ ok: false, error: { code: "chain_break" } });

		const drifted = forgeRecord(records, 1, { operationId: "op-2" });
		expect(replayEffectJournal(drifted)).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });

		const jumped = forgeRecord(records, 1, { phase: "acknowledged" });
		expect(replayEffectJournal(jumped)).toMatchObject({ ok: false, error: { code: "invalid_transition" } });

		const unsafeReplay = forgeRecord(records, 3, { phase: "dispatched" });
		expect(replayEffectJournal(unsafeReplay)).toMatchObject({ ok: false, error: { code: "invalid_transition" } });

		const abandonedWithoutReason = forgeRecord(records, 3, { phase: "abandoned", reasonCode: "" });
		expect(replayEffectJournal(abandonedWithoutReason)).toMatchObject({
			ok: false,
			error: { code: "invalid_record" },
		});

		const wrongSchema = [{ ...records[0], schemaVersion: 1 as unknown as 2 }];
		expect(replayEffectJournal(wrongSchema)).toMatchObject({ ok: false, error: { code: "invalid_record" } });

		expect(
			appendEffectRecord(initialEffectJournalState(), {
				...records[1],
				sequence: 1,
				previousRecordHash: EFFECT_JOURNAL_GENESIS_HASH,
				recordHash: "",
			}),
		).toMatchObject({ ok: false, error: { code: "hash_mismatch" } });
	});

	it("derives stable, domain-separated effect ids", () => {
		const base = { operationId: "op", attemptLogicalIndex: 0, toolCallId: "call-1", intentDigest: "d" };
		expect(deriveEffectId(base)).toBe(deriveEffectId({ ...base }));
		expect(deriveEffectId(base)).not.toBe(deriveEffectId({ ...base, attemptLogicalIndex: 1 }));
		expect(deriveEffectId(base)).not.toBe(deriveEffectId({ ...base, toolCallId: "call-2" }));
		expect(deriveEffectId(base)).not.toBe(deriveEffectId({ ...base, intentDigest: "e" }));
		expect(deriveEffectId({ ...base, resumeToken: "r" })).toBe(
			deriveEffectId({ ...base, attemptLogicalIndex: 5, resumeToken: "r" }),
		);
		expect(deriveEffectId(base)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("effect recovery", () => {
	it("decides conservatively per phase and semantics", () => {
		const table: Array<[EffectPhase, EffectSemantics, string]> = [
			["prepared", "opaque", "replay"],
			["observed_committed", "opaque", "acknowledge"],
			["observed_not_committed", "opaque", "replay"],
			["dispatched", "pure", "replay"],
			["commit_unknown", "idempotent", "replay"],
			["commit_unknown", "inspectable", "inspect"],
			["commit_unknown", "compensatable", "compensate"],
			["commit_unknown", "opaque", "require_operator"],
			["dispatched", "opaque", "require_operator"],
			["compensating", "compensatable", "require_operator"],
			["acknowledged", "pure", "mark_interrupted"],
			["compensated", "pure", "mark_interrupted"],
			["abandoned", "pure", "mark_interrupted"],
		];
		for (const [phase, semantics, action] of table) {
			const record = recordIn(phase, semantics, semantics !== "opaque" && semantics !== "compensatable");
			expect(decideEffectRecovery(record).action, `${phase}/${semantics}`).toBe(action);
		}
		const withDescriptors = recordIn("commit_unknown", "opaque", true);
		expect(decideEffectRecovery(withDescriptors).action).toBe("inspect");
		expect(decideEffectRecovery(withDescriptors, { effectId: "e", outcome: "committed" })).toEqual({
			action: "resolve",
			inspection: "committed",
			reasonCode: "effect.inspection_committed",
		});
		expect(decideEffectRecovery(withDescriptors, { effectId: "e", outcome: "unknown" }).action).toBe("compensate");
		expect(decideEffectRecovery(withDescriptors, { effectId: "other", outcome: "committed" }).action).toBe("inspect");
		expect(
			decideEffectRecovery(recordIn("compensating", "opaque", true), { effectId: "e", outcome: "not_committed" }),
		).toMatchObject({ action: "resolve", inspection: "not_committed" });
	});

	it("computes the uncertainty frontier per operation and blocks verified while non-empty", () => {
		let state = initialEffectJournalState();
		state = step(state, prepareCommand("b", "opaque"));
		state = step(state, { type: "dispatch", effectId: "b", timestamp: T });
		state = step(state, prepareCommand("a", "pure"));
		state = step(state, { type: "dispatch", effectId: "a", timestamp: T });
		state = step(state, { type: "observe", effectId: "a", observation: "unknown", timestamp: T });
		state = step(state, prepareCommand("c", "idempotent"));
		state = step(state, prepareCommand("other", "opaque", { operationId: "op-2" }));
		state = step(state, { type: "dispatch", effectId: "other", timestamp: T });
		const frontier = computeUncertaintyFrontier(state, "op-1");
		expect(frontier.effectIds).toEqual(["a", "b"]);
		expect(frontier.countBySemantics).toEqual({
			pure: 1,
			idempotent: 0,
			inspectable: 0,
			compensatable: 0,
			opaque: 1,
		});
		expect(frontierBlocksVerified(frontier)).toBe(true);
		expect(planEffectRecovery(state, "op-1").map((entry) => [entry.effectId, entry.decision.action])).toEqual([
			["a", "replay"],
			["b", "inspect"],
			["c", "replay"],
		]);
		state = step(state, { type: "redispatch", effectId: "a", timestamp: T });
		state = step(state, { type: "observe", effectId: "a", observation: "committed", timestamp: T });
		state = step(state, { type: "acknowledge", effectId: "a", timestamp: T });
		// A dispatched effect must be closed by an observation before it can be abandoned.
		expect(
			reduceEffectJournal(state, { type: "abandon", effectId: "b", reasonCode: "waiver:w1", timestamp: T }),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
		state = step(state, { type: "observe", effectId: "b", observation: "unknown", timestamp: T });
		state = step(state, { type: "abandon", effectId: "b", reasonCode: "waiver:w1", timestamp: T });
		state = step(state, { type: "abandon", effectId: "c", reasonCode: "operation.interrupted", timestamp: T });
		const cleared = computeUncertaintyFrontier(state, "op-1");
		expect(cleared.effectIds).toEqual([]);
		expect(frontierBlocksVerified(cleared)).toBe(false);
		expect(planEffectRecovery(state, "op-1")).toEqual([]);
		expect(computeUncertaintyFrontier(state, "op-2").effectIds).toEqual(["other"]);
	});
});

describe("effect journal (property)", () => {
	it("random walks keep terminal effects final, never blind-replay unsafe effects, and replay exactly", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...ALL_SEMANTICS),
				fc.array(fc.nat({ max: 11 }), { minLength: 1, maxLength: 40 }),
				(semantics, choices) => {
					let state = step(initialEffectJournalState(), prepareCommand("e", semantics));
					let sawTerminal = false;
					const phases: EffectPhase[] = ["prepared"];
					for (const choice of choices) {
						const command = commandsFor("e")[choice];
						const result = reduceEffectJournal(state, command);
						if (!result.ok) {
							if (sawTerminal) expect(result.error.code).toBe("invalid_transition");
							continue;
						}
						const before = lookupEffect(state, "e");
						if (before?.phase === "commit_unknown" && result.value.record.phase === "dispatched") {
							expect(["pure", "idempotent"]).toContain(semantics);
						}
						state = step(state, command);
						phases.push(result.value.record.phase);
						if (TERMINAL_EFFECT_PHASES.includes(result.value.record.phase)) sawTerminal = true;
					}
					const terminalIndex = phases.findIndex((phase) => TERMINAL_EFFECT_PHASES.includes(phase));
					if (terminalIndex !== -1) expect(terminalIndex).toBe(phases.length - 1);
					const records = collectRecords(state);
					const replayed = replayEffectJournal(records);
					expect(replayed.ok).toBe(true);
					if (replayed.ok) expect(replayed.value).toEqual(state);
					const frontier = computeUncertaintyFrontier(state, "op-1");
					const latest = lookupEffect(state, "e");
					expect(frontier.effectIds.length > 0).toBe(
						latest !== undefined && UNCERTAIN_EFFECT_PHASES.includes(latest.phase),
					);
				},
			),
			{ numRuns: 400, seed: 0xeffec704 },
		);
	});
});

function forgeRecord(records: readonly EffectRecord[], index: number, patch: Partial<EffectRecord>): EffectRecord[] {
	const forged: EffectRecord[] = [];
	let previous = EFFECT_JOURNAL_GENESIS_HASH;
	for (const [position, record] of records.entries()) {
		const { recordHash: _hash, ...body } = position === index ? { ...record, ...patch } : record;
		const chained = { ...body, previousRecordHash: previous };
		const sealed = { ...chained, recordHash: computeEffectRecordHash(chained) };
		forged.push(sealed);
		previous = sealed.recordHash;
	}
	return forged;
}
