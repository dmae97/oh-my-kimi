/**
 * Crash recovery over the effect journal: the uncertainty frontier and the
 * per-effect recovery decision.
 *
 * After a restart the journal is replayed and every effect sits in some
 * phase. This module answers two questions without touching the world:
 *
 * - Which effects are still uncertain? (`computeUncertaintyFrontier`) — the
 *   set that must be empty before an operation may be called verified.
 * - What is the one safe next step for each effect? (`decideEffectRecovery`)
 *   — a deterministic function of the record and an optional inspection
 *   result, so the same journal always produces the same recovery plan.
 *
 * The decision table is conservative by construction: only `pure` and
 * `idempotent` effects are ever replayed blind, `inspectable` effects are
 * inspected first, `compensatable` effects are compensated, and `opaque`
 * effects with an unknown commit always stop at the operator.
 */

import { isReplaySafe } from "./effect-transitions.ts";
import {
	type EffectJournalState,
	type EffectRecord,
	type EffectSemantics,
	UNCERTAIN_EFFECT_PHASES,
} from "./effect-types.ts";

export interface EffectInspectionResult {
	readonly effectId: string;
	readonly outcome: "committed" | "not_committed" | "unknown";
}

export type RecoveryDecision =
	| { readonly action: "replay"; readonly reasonCode: string }
	| { readonly action: "acknowledge"; readonly reasonCode: string }
	| { readonly action: "inspect"; readonly reasonCode: string }
	| { readonly action: "resolve"; readonly inspection: "committed" | "not_committed"; readonly reasonCode: string }
	| { readonly action: "compensate"; readonly reasonCode: string }
	| { readonly action: "mark_interrupted"; readonly reasonCode: string }
	| { readonly action: "require_operator"; readonly reasonCode: string };

function decideFromInspection(record: EffectRecord, inspection: EffectInspectionResult): RecoveryDecision {
	if (inspection.outcome === "committed") {
		return { action: "resolve", inspection: "committed", reasonCode: "effect.inspection_committed" };
	}
	if (inspection.outcome === "not_committed") {
		return { action: "resolve", inspection: "not_committed", reasonCode: "effect.inspection_not_committed" };
	}
	if (record.compensationDescriptor !== undefined) {
		return { action: "compensate", reasonCode: "effect.inspection_unknown_compensate" };
	}
	return { action: "require_operator", reasonCode: "effect.inspection_unknown" };
}

/** Decision for an effect whose commit is not known (crash while dispatched, or commit_unknown). */
function decideUnknownCommit(record: EffectRecord, inspection: EffectInspectionResult | undefined): RecoveryDecision {
	if (isReplaySafe(record.semantics)) return { action: "replay", reasonCode: "effect.replay_safe" };
	if (inspection !== undefined) return decideFromInspection(record, inspection);
	if (record.inspectDescriptor !== undefined) return { action: "inspect", reasonCode: "effect.inspection_required" };
	if (record.compensationDescriptor !== undefined) {
		return { action: "compensate", reasonCode: "effect.compensation_required" };
	}
	return { action: "require_operator", reasonCode: "effect.opaque_commit_unknown" };
}

/** One safe next step for `record`. Pure; an `inspection` for another effect is ignored. */
export function decideEffectRecovery(record: EffectRecord, inspection?: EffectInspectionResult): RecoveryDecision {
	const scoped = inspection?.effectId === record.effectId ? inspection : undefined;
	switch (record.phase) {
		case "acknowledged":
			return { action: "mark_interrupted", reasonCode: "effect.already_acknowledged" };
		case "compensated":
			return { action: "mark_interrupted", reasonCode: "effect.already_compensated" };
		case "abandoned":
			return { action: "mark_interrupted", reasonCode: "effect.already_abandoned" };
		case "prepared":
			return { action: "replay", reasonCode: "effect.not_dispatched" };
		case "observed_committed":
			return { action: "acknowledge", reasonCode: "effect.observed_committed_unacknowledged" };
		case "observed_not_committed":
			return { action: "replay", reasonCode: "effect.retry_not_committed" };
		case "dispatched":
		case "commit_unknown":
			return decideUnknownCommit(record, scoped);
		case "compensating":
			if (scoped !== undefined) return decideFromInspection(record, scoped);
			if (record.inspectDescriptor !== undefined) {
				return { action: "inspect", reasonCode: "effect.compensation_unknown_inspect" };
			}
			return { action: "require_operator", reasonCode: "effect.compensation_unknown" };
	}
}

export interface EffectUncertaintyFrontier {
	readonly operationId: string;
	readonly effectIds: readonly string[];
	readonly countBySemantics: Readonly<Record<EffectSemantics, number>>;
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Effects of `operationId` whose external outcome is unknown, in deterministic id order. */
export function computeUncertaintyFrontier(state: EffectJournalState, operationId: string): EffectUncertaintyFrontier {
	const countBySemantics: Record<EffectSemantics, number> = {
		pure: 0,
		idempotent: 0,
		inspectable: 0,
		compensatable: 0,
		opaque: 0,
	};
	const effectIds: string[] = [];
	for (const record of Object.values(state.effects)) {
		if (record.operationId !== operationId || !UNCERTAIN_EFFECT_PHASES.includes(record.phase)) continue;
		effectIds.push(record.effectId);
		countBySemantics[record.semantics] += 1;
	}
	effectIds.sort(compareCodeUnits);
	return { operationId, effectIds, countBySemantics };
}

/** A verified verdict requires an empty frontier; anything else is at most inconclusive. */
export function frontierBlocksVerified(frontier: EffectUncertaintyFrontier): boolean {
	return frontier.effectIds.length > 0;
}

export interface EffectRecoveryPlanEntry {
	readonly effectId: string;
	readonly phase: EffectRecord["phase"];
	readonly semantics: EffectSemantics;
	readonly decision: RecoveryDecision;
}

/**
 * Recovery decisions for every non-terminal effect of an operation, in id
 * order. Terminal effects are omitted: they need no action, and listing them
 * would bury the frontier in noise.
 */
export function planEffectRecovery(
	state: EffectJournalState,
	operationId: string,
	inspections: readonly EffectInspectionResult[] = [],
): readonly EffectRecoveryPlanEntry[] {
	const byEffect = new Map(inspections.map((inspection) => [inspection.effectId, inspection]));
	const entries: EffectRecoveryPlanEntry[] = [];
	for (const record of Object.values(state.effects)) {
		if (record.operationId !== operationId) continue;
		const decision = decideEffectRecovery(record, byEffect.get(record.effectId));
		if (decision.action === "mark_interrupted") continue;
		entries.push({ effectId: record.effectId, phase: record.phase, semantics: record.semantics, decision });
	}
	return entries.sort((left, right) => compareCodeUnits(left.effectId, right.effectId));
}
