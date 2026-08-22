/**
 * Governor rollout mode (§7.4). Mode enforcement (probe/record/cap wiring)
 * lands in later milestones; the type is part of the layer-1 contract.
 */
export type ResourceGovernorMode = "off" | "observe" | "adaptive" | "strict";

export interface ResourceAdmissionThresholds {
	readonly constrainedAvailableMemoryMiB: number;
	readonly criticalAvailableMemoryMiB: number;
	readonly constrainedDiskFreeMiB: number;
	readonly criticalDiskFreeMiB: number;
	readonly constrainedHeapRatio: number;
	readonly criticalHeapRatio: number;
	readonly busyCpuPercent: number;
}

export interface ResourcePressureCaps {
	readonly maxToolConcurrency: number;
	readonly maxParallelLanes: number;
	readonly maxHeavyProcesses: number;
}

export interface ResourceAdmissionCapTable {
	readonly normal: ResourcePressureCaps;
	readonly constrained: ResourcePressureCaps;
	readonly critical: ResourcePressureCaps;
}

export interface ResourceAdmissionConfig {
	readonly thresholds: ResourceAdmissionThresholds;
	readonly caps: ResourceAdmissionCapTable;
}

/** §6.7 default thresholds. */
export const DEFAULT_RESOURCE_ADMISSION_THRESHOLDS: ResourceAdmissionThresholds = {
	constrainedAvailableMemoryMiB: 1536,
	criticalAvailableMemoryMiB: 512,
	constrainedDiskFreeMiB: 4096,
	criticalDiskFreeMiB: 1024,
	constrainedHeapRatio: 0.75,
	criticalHeapRatio: 0.85,
	busyCpuPercent: 85,
};

/** §7.2 default caps per pressure tier. */
export const DEFAULT_RESOURCE_ADMISSION_CAP_TABLE: ResourceAdmissionCapTable = {
	normal: { maxToolConcurrency: 4, maxParallelLanes: 4, maxHeavyProcesses: 2 },
	constrained: { maxToolConcurrency: 2, maxParallelLanes: 2, maxHeavyProcesses: 1 },
	critical: { maxToolConcurrency: 1, maxParallelLanes: 1, maxHeavyProcesses: 1 },
};

export const DEFAULT_RESOURCE_ADMISSION_CONFIG: ResourceAdmissionConfig = {
	thresholds: DEFAULT_RESOURCE_ADMISSION_THRESHOLDS,
	caps: DEFAULT_RESOURCE_ADMISSION_CAP_TABLE,
};

export type ResourceAdmissionConfigOverrides = {
	thresholds?: Partial<ResourceAdmissionThresholds>;
	caps?: {
		normal?: Partial<ResourcePressureCaps>;
		constrained?: Partial<ResourcePressureCaps>;
		critical?: Partial<ResourcePressureCaps>;
	};
};

export interface ResolvedResourceAdmissionConfig {
	readonly config: ResourceAdmissionConfig;
	/** §18.1: explicit errors over silent clamps. Non-empty means fail-closed defaults were applied. */
	readonly errors: readonly string[];
}

const MIN_CAP = 1;
const MAX_CAP = 64;

/**
 * Validate overrides against §18.1 and merge them over the defaults.
 * Any validation error fails closed: the full default config is returned
 * together with the explicit error list (startup diagnostics are the
 * caller's responsibility in later slices).
 */
export function resolveResourceAdmissionConfig(
	overrides?: ResourceAdmissionConfigOverrides,
): ResolvedResourceAdmissionConfig {
	const merged: ResourceAdmissionConfig = {
		thresholds: { ...DEFAULT_RESOURCE_ADMISSION_THRESHOLDS, ...overrides?.thresholds },
		caps: {
			normal: { ...DEFAULT_RESOURCE_ADMISSION_CAP_TABLE.normal, ...overrides?.caps?.normal },
			constrained: { ...DEFAULT_RESOURCE_ADMISSION_CAP_TABLE.constrained, ...overrides?.caps?.constrained },
			critical: { ...DEFAULT_RESOURCE_ADMISSION_CAP_TABLE.critical, ...overrides?.caps?.critical },
		},
	};
	const errors = validateResourceAdmissionConfig(merged);
	if (errors.length > 0) {
		return { config: DEFAULT_RESOURCE_ADMISSION_CONFIG, errors };
	}
	return { config: merged, errors };
}

export function validateResourceAdmissionConfig(config: ResourceAdmissionConfig): readonly string[] {
	const errors: string[] = [];
	const { thresholds, caps } = config;

	const positiveMiB: ReadonlyArray<readonly [string, number]> = [
		["constrainedAvailableMemoryMiB", thresholds.constrainedAvailableMemoryMiB],
		["criticalAvailableMemoryMiB", thresholds.criticalAvailableMemoryMiB],
		["constrainedDiskFreeMiB", thresholds.constrainedDiskFreeMiB],
		["criticalDiskFreeMiB", thresholds.criticalDiskFreeMiB],
	];
	for (const [name, value] of positiveMiB) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			errors.push(`resourceGovernor.${name}: must be a positive safe integer, got ${String(value)}`);
		}
	}
	if (thresholds.criticalAvailableMemoryMiB > thresholds.constrainedAvailableMemoryMiB) {
		errors.push("resourceGovernor.criticalAvailableMemoryMiB: must be <= constrainedAvailableMemoryMiB");
	}
	if (thresholds.criticalDiskFreeMiB > thresholds.constrainedDiskFreeMiB) {
		errors.push("resourceGovernor.criticalDiskFreeMiB: must be <= constrainedDiskFreeMiB");
	}
	for (const [name, value] of [
		["constrainedHeapRatio", thresholds.constrainedHeapRatio],
		["criticalHeapRatio", thresholds.criticalHeapRatio],
	] as const) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
			errors.push(`resourceGovernor.${name}: must be within (0, 1], got ${String(value)}`);
		}
	}
	if (thresholds.criticalHeapRatio < thresholds.constrainedHeapRatio) {
		errors.push("resourceGovernor.criticalHeapRatio: must be >= constrainedHeapRatio");
	}
	if (
		!Number.isFinite(thresholds.busyCpuPercent) ||
		thresholds.busyCpuPercent < 1 ||
		thresholds.busyCpuPercent > 100
	) {
		errors.push(`resourceGovernor.busyCpuPercent: must be within [1, 100], got ${String(thresholds.busyCpuPercent)}`);
	}

	const capFields = ["maxToolConcurrency", "maxParallelLanes", "maxHeavyProcesses"] as const;
	for (const tier of ["normal", "constrained", "critical"] as const) {
		for (const field of capFields) {
			const value = caps[tier][field];
			if (!Number.isSafeInteger(value) || value < MIN_CAP || value > MAX_CAP) {
				errors.push(
					`resourceGovernor.caps.${tier}.${field}: must be an integer within [${MIN_CAP}, ${MAX_CAP}], got ${String(value)}`,
				);
			}
		}
	}
	// §4.4 / §18.1 monotonicity: normalCap >= constrainedCap >= criticalCap.
	for (const field of capFields) {
		if (caps.normal[field] < caps.constrained[field] || caps.constrained[field] < caps.critical[field]) {
			errors.push(`resourceGovernor.caps.${field}: requires normal >= constrained >= critical`);
		}
	}
	return errors;
}
