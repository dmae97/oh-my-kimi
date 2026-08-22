import type { ResourceAdmissionDecision, ResourcePressure, ResourceReasonCode } from "./resource-admission.ts";
import type { WorkloadClassification } from "./workload-classifier.ts";

/**
 * Pure resource safety gate decision (OMK v0.97.x roadmap §11, M3/PR4).
 *
 * Maps (workload classification × admission decision) to a gate verdict.
 * This module holds no permits and spawns nothing — the shared permit pool
 * and the bash/launch integration consume these verdicts in the next slice.
 *
 * Order contract (§9.4, §22.2): command safety runs FIRST and stays
 * authoritative. The input requires the literal `commandSafety: "allowed"`
 * so a call site cannot even type-check unless the command already passed
 * the safety gate; resource pressure can only throttle or defer an
 * already-allowed command, never re-admit a blocked one.
 *
 * Fail-closed only where side effects matter (§4.6): heavy work and opaque
 * complex shell are deferred at critical pressure, while light reads and
 * bounded IO stay allowed so the agent remains usable (§21).
 */

export interface ResourceSafetyGateInput {
	/** §9.4: structurally requires the command-safety gate to have allowed the command. */
	readonly commandSafety: "allowed";
	readonly classification: WorkloadClassification;
	readonly decision: ResourceAdmissionDecision;
}

/** §11.3 structured block result. Bounded: no raw host values, paths, or identities. */
export interface ResourcePressureBlock {
	readonly kind: "resource_pressure";
	readonly pressure: ResourcePressure;
	readonly action: "defer-heavy";
	readonly reasonCodes: readonly ResourceReasonCode[];
	readonly requiredAction: string;
}

export type ResourceSafetyGateVerdict =
	| { readonly kind: "allow" }
	| { readonly kind: "require-permit"; readonly weight: 1 | 2 }
	| { readonly kind: "block"; readonly block: ResourcePressureBlock };

export const RESOURCE_PRESSURE_REQUIRED_ACTION = "Create a bounded shard plan or free resources before retrying.";

/**
 * Decide the §11.2 gate behavior for one already-safety-allowed command.
 *
 * | pressure    | light | io    | cpu      | heavy / memory | unknown complex shell |
 * | ----------- | ----- | ----- | -------- | -------------- | --------------------- |
 * | normal      | allow | allow | permit   | permit         | permit, no rewrite    |
 * | constrained | allow | allow | permit 1 | permit 1       | permit 1, no rewrite  |
 * | critical    | allow | allow | permit 1 | block/defer    | block/defer           |
 */
export function decideResourceSafetyGate(input: ResourceSafetyGateInput): ResourceSafetyGateVerdict {
	const { classification, decision } = input;
	const critical = decision.pressure === "critical";

	if (classification.workloadClass === "light") {
		return { kind: "allow" };
	}
	if (classification.workloadClass === "io") {
		// Critical still allows bounded IO; the run lease already caps overall
		// tool concurrency (§11.2 "allow with cap").
		return { kind: "allow" };
	}
	if (classification.workloadClass === "cpu") {
		return { kind: "require-permit", weight: 1 };
	}

	// heavy, memory (heavy-equivalent — the §11.2 table has no softer column
	// for memory-bound work), and unknown workloads.
	const heavyEquivalent = classification.workloadClass === "heavy" || classification.workloadClass === "memory";
	const opaqueComplexShell =
		classification.workloadClass === "unknown" && classification.complexity === "complex-shell";

	if (critical && (heavyEquivalent || opaqueComplexShell)) {
		return {
			kind: "block",
			block: {
				kind: "resource_pressure",
				pressure: decision.pressure,
				action: "defer-heavy",
				reasonCodes: decision.reasons,
				requiredAction: RESOURCE_PRESSURE_REQUIRED_ACTION,
			},
		};
	}
	if (heavyEquivalent) {
		// §10.3: container builds may consume double weight in the permit pool.
		return { kind: "require-permit", weight: classification.commandFamily === "container-build" ? 2 : 1 };
	}
	// unknown (simple argv or, below critical, complex shell): permit-gated so
	// fanout stays bounded, but never blocked outright below critical, and a
	// simple unknown binary stays runnable even at critical (§21: the agent
	// must remain usable).
	return { kind: "require-permit", weight: 1 };
}
