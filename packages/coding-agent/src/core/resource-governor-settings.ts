import type {
	ResourceAdmissionConfig,
	ResourceAdmissionConfigOverrides,
	ResourceGovernorMode,
} from "./resource-admission.ts";
import { resolveResourceAdmissionConfig } from "./resource-admission.ts";
import { MAX_CPU_SAMPLE_MS, MIN_CPU_SAMPLE_MS } from "./system-cpu-sampler.ts";

export {
	buildResourceDoctorReport,
	describeResourceReasons,
	formatResourcePolicyLines,
	formatResourceProbeLines,
	formatResourceSummaryLines,
	type ResourceDoctorReport,
} from "./resource-governor-format.ts";

/**
 * Resource governor settings surface (OMK v0.97.x roadmap §18, M1/PR2).
 *
 * Pure translation from the additive `resourceGovernor` settings block (and
 * the §18.2 `OMK_RESOURCE_GOVERNOR` env override) to the layer-1 admission
 * config plus probe options. Validation follows §18.1: explicit errors over
 * silent clamps, and invalid input fails closed to the defaults.
 *
 * Resolved values feed the `/resource` command, `omk doctor resources`, and
 * the M2 prompt preflight: `observe` records decisions only, while
 * `adaptive`/`strict` let the run lease throttle per-run tool concurrency.
 * Lane and heavy-process caps become authoritative in later milestones.
 */

/** Additive settings block (§18, §29.1: absent block keeps v0.96.1 behavior). */
export interface ResourceGovernorSettings {
	enabled?: boolean; // default: true; false forces mode "off"
	mode?: ResourceGovernorMode; // default: "observe" (v0.97.0-alpha rollout stage, §7.4)

	maxProbeMs?: number; // default: 300; async probe deadline, valid 50..5000 (§18.1)
	cpuSampleMs?: number; // default: 180; CPU two-sample interval, valid 150..250 (§6.3)

	constrainedAvailableMemoryMiB?: number; // default: 1536 (§6.7)
	criticalAvailableMemoryMiB?: number; // default: 512
	constrainedDiskFreeMiB?: number; // default: 4096
	criticalDiskFreeMiB?: number; // default: 1024
	constrainedHeapRatio?: number; // default: 0.75
	criticalHeapRatio?: number; // default: 0.85
	busyCpuPercent?: number; // default: 85

	normalMaxToolConcurrency?: number; // default: 4 (§7.2)
	constrainedMaxToolConcurrency?: number; // default: 2
	criticalMaxToolConcurrency?: number; // default: 1
	normalMaxParallelLanes?: number; // default: 4
	constrainedMaxParallelLanes?: number; // default: 2
	criticalMaxParallelLanes?: number; // default: 1
	normalMaxHeavyProcesses?: number; // default: 2
	constrainedMaxHeavyProcesses?: number; // default: 1
	criticalMaxHeavyProcesses?: number; // default: 1
}

export const RESOURCE_GOVERNOR_MODE_ENV = "OMK_RESOURCE_GOVERNOR";
export const DEFAULT_RESOURCE_GOVERNOR_MODE: ResourceGovernorMode = "observe";
const RESOURCE_GOVERNOR_MODES: ReadonlySet<string> = new Set(["off", "observe", "adaptive", "strict"]);

export interface ResolvedResourceGovernorSettings {
	readonly mode: ResourceGovernorMode;
	/** Only present when the setting is valid; the probe applies its own defaults otherwise. */
	readonly maxProbeMs?: number;
	readonly cpuSampleMs?: number;
	readonly admission: ResourceAdmissionConfig;
	/** §18.1 explicit validation errors; non-empty means defaults were applied for the failed area. */
	readonly errors: readonly string[];
}

/**
 * Resolve settings + environment into governor mode, probe options, and the
 * admission config. Never throws; every invalid field produces an explicit
 * error and falls back to the corresponding default (§18.1 fail-closed).
 */
export function resolveResourceGovernorSettings(
	settings?: ResourceGovernorSettings,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedResourceGovernorSettings {
	const errors: string[] = [];
	const mode = resolveMode(settings, env, errors);

	const maxProbeMs = validateRange(settings?.maxProbeMs, "maxProbeMs", 50, 5000, errors);
	const cpuSampleMs = validateRange(
		settings?.cpuSampleMs,
		"cpuSampleMs",
		MIN_CPU_SAMPLE_MS,
		MAX_CPU_SAMPLE_MS,
		errors,
	);

	const overrides: ResourceAdmissionConfigOverrides = {
		thresholds: pruneUndefined({
			constrainedAvailableMemoryMiB: settings?.constrainedAvailableMemoryMiB,
			criticalAvailableMemoryMiB: settings?.criticalAvailableMemoryMiB,
			constrainedDiskFreeMiB: settings?.constrainedDiskFreeMiB,
			criticalDiskFreeMiB: settings?.criticalDiskFreeMiB,
			constrainedHeapRatio: settings?.constrainedHeapRatio,
			criticalHeapRatio: settings?.criticalHeapRatio,
			busyCpuPercent: settings?.busyCpuPercent,
		}),
		caps: {
			normal: pruneUndefined({
				maxToolConcurrency: settings?.normalMaxToolConcurrency,
				maxParallelLanes: settings?.normalMaxParallelLanes,
				maxHeavyProcesses: settings?.normalMaxHeavyProcesses,
			}),
			constrained: pruneUndefined({
				maxToolConcurrency: settings?.constrainedMaxToolConcurrency,
				maxParallelLanes: settings?.constrainedMaxParallelLanes,
				maxHeavyProcesses: settings?.constrainedMaxHeavyProcesses,
			}),
			critical: pruneUndefined({
				maxToolConcurrency: settings?.criticalMaxToolConcurrency,
				maxParallelLanes: settings?.criticalMaxParallelLanes,
				maxHeavyProcesses: settings?.criticalMaxHeavyProcesses,
			}),
		},
	};
	const admission = resolveResourceAdmissionConfig(overrides);
	errors.push(...admission.errors);

	return { mode, maxProbeMs, cpuSampleMs, admission: admission.config, errors };
}

function resolveMode(
	settings: ResourceGovernorSettings | undefined,
	env: NodeJS.ProcessEnv,
	errors: string[],
): ResourceGovernorMode {
	// §18.2/§30.1: the env override is the operator kill switch and wins.
	const envMode = env[RESOURCE_GOVERNOR_MODE_ENV]?.trim();
	if (envMode !== undefined && envMode !== "") {
		if (RESOURCE_GOVERNOR_MODES.has(envMode)) {
			return envMode as ResourceGovernorMode;
		}
		errors.push(`resourceGovernor.mode: invalid ${RESOURCE_GOVERNOR_MODE_ENV} value ${JSON.stringify(envMode)}`);
	}
	if (settings?.enabled === false) {
		return "off";
	}
	const configured = settings?.mode;
	if (configured !== undefined) {
		if (RESOURCE_GOVERNOR_MODES.has(configured)) {
			return configured;
		}
		errors.push(`resourceGovernor.mode: invalid value ${JSON.stringify(configured)}`);
	}
	return DEFAULT_RESOURCE_GOVERNOR_MODE;
}

function validateRange(
	value: number | undefined,
	field: string,
	min: number,
	max: number,
	errors: string[],
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		errors.push(`resourceGovernor.${field}: must be an integer within [${min}, ${max}], got ${String(value)}`);
		return undefined;
	}
	return value;
}

function pruneUndefined<T extends Record<string, number | undefined>>(record: T): Partial<T> {
	const pruned: Record<string, number> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) {
			pruned[key] = value;
		}
	}
	return pruned as Partial<T>;
}
