import { randomUUID } from "node:crypto";
import {
	computeHostResourceSnapshotDigest,
	effectiveAvailableMemoryBytes,
	type HostResourceSnapshot,
} from "./host-resource-snapshot.ts";
import {
	DEFAULT_RESOURCE_ADMISSION_CONFIG,
	DEFAULT_RESOURCE_ADMISSION_THRESHOLDS,
	type ResourceAdmissionConfig,
	type ResourceAdmissionThresholds,
} from "./resource-admission-config.ts";

export type {
	ResolvedResourceAdmissionConfig,
	ResourceAdmissionCapTable,
	ResourceAdmissionConfig,
	ResourceAdmissionConfigOverrides,
	ResourceAdmissionThresholds,
	ResourceGovernorMode,
	ResourcePressureCaps,
} from "./resource-admission-config.ts";
export {
	DEFAULT_RESOURCE_ADMISSION_CAP_TABLE,
	DEFAULT_RESOURCE_ADMISSION_CONFIG,
	DEFAULT_RESOURCE_ADMISSION_THRESHOLDS,
	resolveResourceAdmissionConfig,
	validateResourceAdmissionConfig,
} from "./resource-admission-config.ts";

/**
 * Pure resource admission policy (OMK v0.97.x roadmap §6.6-§7, M1/PR1).
 *
 * This module maps an immutable {@link HostResourceSnapshot} to an immutable
 * {@link ResourceAdmissionDecision}. It is deterministic (clock and id are
 * injectable), side-effect free, and performs no scheduler wiring — the
 * decision only becomes scheduler authority in later milestones (M2+).
 *
 * Policy invariants (verified by property tests, roadmap §23.2):
 * - Monotonic degradation (§4.4): worse memory/disk/CPU never improves
 *   pressure and never raises a cap.
 * - Conservative unknown handling (§4.3): a known critical fact wins; a
 *   missing key probe (memory, disk, heap) degrades to `constrained`; only a
 *   fully healthy snapshot is `normal`.
 * - CPU alone never produces `critical` (§6.7): CPU pressure throttles,
 *   while memory/disk/heap may block heavy admission.
 * - User cap precedence (§7.3): effective caps never exceed configured caps,
 *   and `0 = unlimited` settings are limited to the admission cap.
 */

export const RESOURCE_ADMISSION_VERSION = 1 as const;

export type ResourcePressure = "normal" | "constrained" | "critical";

export type ResourceAdmissionAction = "allow" | "throttle" | "defer-heavy";

export type ResourceReasonCode =
	| "resource.memory.low"
	| "resource.memory.critical"
	| "resource.disk.low"
	| "resource.disk.critical"
	| "resource.cpu.busy"
	| "resource.heap.high"
	| "resource.heap.critical"
	| "resource.probe.partial"
	| "resource.probe.timeout";

export interface ResourceAdmissionDecision {
	readonly schemaVersion: typeof RESOURCE_ADMISSION_VERSION;
	readonly decisionId: string;
	readonly snapshotDigest: string;
	readonly pressure: ResourcePressure;
	readonly action: ResourceAdmissionAction;

	readonly maxToolConcurrency: number;
	readonly maxParallelLanes: number;
	readonly maxHeavyProcesses: number;

	readonly reasons: readonly ResourceReasonCode[];
	readonly decidedAt: string;
}

/** Bounded model-facing hint (§6.2). Never expose the raw snapshot to the model. */
export interface ModelResourceBudgetHint {
	readonly pressure: ResourcePressure;
	readonly maxToolConcurrency: number;
	readonly maxParallelLanes: number;
	readonly maxHeavyProcesses: number;
	readonly reasons: readonly ResourceReasonCode[];
}

const MIB = 1024 * 1024;
const MIN_CAP = 1;
const PRESSURE_RANK: Record<ResourcePressure, number> = { normal: 0, constrained: 1, critical: 2 };
const RANK_TO_PRESSURE: readonly ResourcePressure[] = ["normal", "constrained", "critical"];
/** §7 action mapping: allow at normal, throttle at constrained, defer heavy work at critical. */
const ACTION_BY_PRESSURE: Record<ResourcePressure, ResourceAdmissionAction> = {
	normal: "allow",
	constrained: "throttle",
	critical: "defer-heavy",
};

/** Total order for pressure levels: `normal` (0) < `constrained` (1) < `critical` (2). */
export function resourcePressureRank(pressure: ResourcePressure): number {
	return PRESSURE_RANK[pressure];
}

export interface ResourcePressureEvaluation {
	readonly pressure: ResourcePressure;
	readonly reasons: readonly ResourceReasonCode[];
}

/**
 * Derive pressure and reason codes from a snapshot (§4.3, §6.6, §6.7).
 * Pure and monotonic: strictly worse inputs never yield a better pressure.
 */
export function evaluateResourcePressure(
	snapshot: HostResourceSnapshot,
	thresholds: ResourceAdmissionThresholds = DEFAULT_RESOURCE_ADMISSION_THRESHOLDS,
): ResourcePressureEvaluation {
	const reasons: ResourceReasonCode[] = [];
	let rank = PRESSURE_RANK.normal;
	const escalate = (target: ResourcePressure, reason: ResourceReasonCode): void => {
		reasons.push(reason);
		rank = Math.max(rank, PRESSURE_RANK[target]);
	};

	const memory = effectiveAvailableMemoryBytes(snapshot);
	if (memory !== null) {
		if (memory < thresholds.criticalAvailableMemoryMiB * MIB) {
			escalate("critical", "resource.memory.critical");
		} else if (memory < thresholds.constrainedAvailableMemoryMiB * MIB) {
			escalate("constrained", "resource.memory.low");
		}
	}

	const disk = snapshot.workspaceAvailableBytes;
	if (disk !== null) {
		if (disk < thresholds.criticalDiskFreeMiB * MIB) {
			escalate("critical", "resource.disk.critical");
		} else if (disk < thresholds.constrainedDiskFreeMiB * MIB) {
			escalate("constrained", "resource.disk.low");
		}
	}

	const heapRatio = snapshot.heapLimitBytes > 0 ? snapshot.heapUsedBytes / snapshot.heapLimitBytes : null;
	if (heapRatio !== null) {
		if (heapRatio >= thresholds.criticalHeapRatio) {
			escalate("critical", "resource.heap.critical");
		} else if (heapRatio >= thresholds.constrainedHeapRatio) {
			escalate("constrained", "resource.heap.high");
		}
	}

	// §6.7: CPU pressure only throttles; it can never be critical on its own.
	if (snapshot.systemCpuPercent !== null && snapshot.systemCpuPercent >= thresholds.busyCpuPercent) {
		escalate("constrained", "resource.cpu.busy");
	}

	// §4.3 conservative unknown handling. Key probes are the heavy-admission
	// authorities (memory, disk, heap); a missing one degrades to constrained.
	if (memory === null || disk === null || heapRatio === null) {
		escalate("constrained", "resource.probe.partial");
	}
	// §21: any probe timeout keeps the prompt going but never reports normal.
	if (snapshot.diagnostics.some((code) => code.endsWith(".timeout"))) {
		escalate("constrained", "resource.probe.timeout");
	}

	return { pressure: RANK_TO_PRESSURE[rank] ?? "critical", reasons };
}

/**
 * Existing user settings that admission must never exceed (§7.3).
 * `0` or `undefined` means "unlimited" and is limited to the admission cap.
 */
export interface ConfiguredResourceCaps {
	readonly maxToolConcurrency?: number;
	readonly maxParallelLanes?: number;
	readonly maxHeavyProcesses?: number;
}

export interface ResourceAdmissionInput {
	readonly snapshot: HostResourceSnapshot;
	readonly config?: ResourceAdmissionConfig;
	readonly configuredCaps?: ConfiguredResourceCaps;
	/** Injectable for deterministic tests; defaults to a UUID-based id. */
	readonly decisionId?: string;
	/** Injectable ISO timestamp; defaults to the current time. */
	readonly decidedAt?: string;
}

/** Map a snapshot to an immutable admission decision (§7.1-§7.3). */
export function decideResourceAdmission(input: ResourceAdmissionInput): ResourceAdmissionDecision {
	const config = input.config ?? DEFAULT_RESOURCE_ADMISSION_CONFIG;
	const { pressure, reasons } = evaluateResourcePressure(input.snapshot, config.thresholds);
	const tier = config.caps[pressure];
	return {
		schemaVersion: RESOURCE_ADMISSION_VERSION,
		decisionId: input.decisionId ?? `res-adm-${randomUUID()}`,
		snapshotDigest: computeHostResourceSnapshotDigest(input.snapshot),
		pressure,
		action: ACTION_BY_PRESSURE[pressure],
		maxToolConcurrency: effectiveCap(input.configuredCaps?.maxToolConcurrency, tier.maxToolConcurrency),
		maxParallelLanes: effectiveCap(input.configuredCaps?.maxParallelLanes, tier.maxParallelLanes),
		maxHeavyProcesses: effectiveCap(input.configuredCaps?.maxHeavyProcesses, tier.maxHeavyProcesses),
		reasons,
		decidedAt: input.decidedAt ?? new Date().toISOString(),
	};
}

/** Bounded hint for the model (§6.2). Carries no raw host values. */
export function toModelResourceBudgetHint(decision: ResourceAdmissionDecision): ModelResourceBudgetHint {
	return {
		pressure: decision.pressure,
		maxToolConcurrency: decision.maxToolConcurrency,
		maxParallelLanes: decision.maxParallelLanes,
		maxHeavyProcesses: decision.maxHeavyProcesses,
		reasons: decision.reasons,
	};
}

/** §7.3: `min(configured, admission)`, where configured `0`/absent means unlimited. */
function effectiveCap(configured: number | undefined, admission: number): number {
	const admitted = Math.max(MIN_CAP, Math.floor(admission));
	if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
		return admitted;
	}
	return Math.max(MIN_CAP, Math.min(Math.floor(configured), admitted));
}
