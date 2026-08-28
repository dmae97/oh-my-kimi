import type { HostResourceSnapshot } from "./host-resource-snapshot.ts";
import { effectiveAvailableMemoryBytes } from "./host-resource-snapshot.ts";
import type { ResourceAdmissionDecision, ResourceGovernorMode, ResourceReasonCode } from "./resource-admission.ts";
import type { ResolvedResourceGovernorSettings } from "./resource-governor-types.ts";

const REASON_LABELS: Record<ResourceReasonCode, string> = {
	"resource.memory.low": "memory low",
	"resource.memory.critical": "memory critical",
	"resource.disk.low": "disk low",
	"resource.disk.critical": "disk critical",
	"resource.cpu.busy": "CPU busy",
	"resource.heap.high": "heap high",
	"resource.heap.critical": "heap critical",
	"resource.probe.partial": "partial probe",
	"resource.probe.timeout": "probe timeout",
};

/** Humanize reason codes for the §19.1 summary line ("memory low, CPU busy"). */
export function describeResourceReasons(reasons: readonly ResourceReasonCode[]): string {
	if (reasons.length === 0) {
		return "none";
	}
	return reasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ");
}

/** §19.1 summary block shared by `/resource` and the doctor's human output. */
export function formatResourceSummaryLines(mode: ResourceGovernorMode, decision: ResourceAdmissionDecision): string[] {
	return [
		`mode: ${mode}`,
		`pressure: ${decision.pressure}`,
		`action: ${decision.action}`,
		`tool concurrency: ${decision.maxToolConcurrency}`,
		`subagent lanes: ${decision.maxParallelLanes}`,
		`heavy processes: ${decision.maxHeavyProcesses}`,
		`reasons: ${describeResourceReasons(decision.reasons)}`,
	];
}

/**
 * Verbose probe details for explicit local diagnostics only (§19.1 verbose,
 * §11.3: raw values never enter tool results or model prompts).
 */
export function formatResourceProbeLines(snapshot: HostResourceSnapshot): string[] {
	const heapRatio = snapshot.heapLimitBytes > 0 ? snapshot.heapUsedBytes / snapshot.heapLimitBytes : null;
	const lines = [
		`observed at: ${snapshot.observedAt}`,
		`environment: ${snapshot.environment} (${snapshot.platform}/${snapshot.arch}, ${snapshot.logicalCpuCount} CPUs)`,
		`effective available memory: ${formatMiB(effectiveAvailableMemoryBytes(snapshot))}`,
		`  process available: ${formatMiB(snapshot.processAvailableMemoryBytes)}`,
		`  constrained limit: ${formatMiB(snapshot.constrainedMemoryBytes)}`,
		`  host free: ${formatMiB(snapshot.hostFreeMemoryBytes)} of ${formatMiB(snapshot.hostTotalMemoryBytes)}`,
		`workspace disk available: ${formatMiB(snapshot.workspaceAvailableBytes)}`,
		`heap: ${formatMiB(snapshot.heapUsedBytes)} of ${formatMiB(snapshot.heapLimitBytes)}${heapRatio === null ? "" : ` (${(heapRatio * 100).toFixed(1)}%)`}`,
		`system CPU: ${snapshot.systemCpuPercent === null ? "unknown" : `${snapshot.systemCpuPercent.toFixed(1)}%`}`,
	];
	if (snapshot.diagnostics.length > 0) {
		lines.push(`diagnostics: ${snapshot.diagnostics.join(", ")}`);
	}
	return lines;
}

/** Policy view: mode, §6.7 thresholds, §7.2 caps, and §18.1 validation errors. */
export function formatResourcePolicyLines(resolved: ResolvedResourceGovernorSettings): string[] {
	const { thresholds, caps } = resolved.admission;
	const lines = [
		`mode: ${resolved.mode}`,
		`probe deadline: ${resolved.maxProbeMs ?? 300} ms, CPU sample: ${resolved.cpuSampleMs ?? 180} ms`,
		`memory MiB (constrained/critical): ${thresholds.constrainedAvailableMemoryMiB}/${thresholds.criticalAvailableMemoryMiB}`,
		`disk MiB (constrained/critical): ${thresholds.constrainedDiskFreeMiB}/${thresholds.criticalDiskFreeMiB}`,
		`heap ratio (constrained/critical): ${thresholds.constrainedHeapRatio}/${thresholds.criticalHeapRatio}`,
		`busy CPU percent: ${thresholds.busyCpuPercent}`,
		`caps normal: tools ${caps.normal.maxToolConcurrency}, lanes ${caps.normal.maxParallelLanes}, heavy ${caps.normal.maxHeavyProcesses}`,
		`caps constrained: tools ${caps.constrained.maxToolConcurrency}, lanes ${caps.constrained.maxParallelLanes}, heavy ${caps.constrained.maxHeavyProcesses}`,
		`caps critical: tools ${caps.critical.maxToolConcurrency}, lanes ${caps.critical.maxParallelLanes}, heavy ${caps.critical.maxHeavyProcesses}`,
	];
	for (const error of resolved.errors) {
		lines.push(`error: ${error}`);
	}
	return lines;
}

/** Bounded JSON schema for `omk doctor resources --json` (§19.2). */
export interface ResourceDoctorReport {
	readonly schemaVersion: 1;
	readonly command: "resource_doctor";
	readonly mode: ResourceGovernorMode;
	readonly pressure: ResourceAdmissionDecision["pressure"];
	readonly action: ResourceAdmissionDecision["action"];
	readonly caps: {
		readonly maxToolConcurrency: number;
		readonly maxParallelLanes: number;
		readonly maxHeavyProcesses: number;
	};
	readonly reasons: readonly ResourceReasonCode[];
	readonly probeDurationMs: number;
	readonly snapshot: {
		readonly environment: HostResourceSnapshot["environment"];
		readonly logicalCpuCount: number;
		readonly effectiveAvailableMemoryMiB: number | null;
		readonly processAvailableMemoryMiB: number | null;
		readonly constrainedMemoryMiB: number | null;
		readonly hostFreeMemoryMiB: number | null;
		readonly hostTotalMemoryMiB: number | null;
		readonly workspaceAvailableMiB: number | null;
		readonly heapUsedRatio: number | null;
		readonly systemCpuPercent: number | null;
		readonly diagnostics: readonly string[];
	};
	readonly settingsErrors: readonly string[];
}

export function buildResourceDoctorReport(input: {
	readonly snapshot: HostResourceSnapshot;
	readonly decision: ResourceAdmissionDecision;
	readonly resolved: ResolvedResourceGovernorSettings;
	readonly probeDurationMs: number;
}): ResourceDoctorReport {
	const { snapshot, decision, resolved } = input;
	const heapRatio = snapshot.heapLimitBytes > 0 ? snapshot.heapUsedBytes / snapshot.heapLimitBytes : null;
	return {
		schemaVersion: 1,
		command: "resource_doctor",
		mode: resolved.mode,
		pressure: decision.pressure,
		action: decision.action,
		caps: {
			maxToolConcurrency: decision.maxToolConcurrency,
			maxParallelLanes: decision.maxParallelLanes,
			maxHeavyProcesses: decision.maxHeavyProcesses,
		},
		reasons: decision.reasons,
		probeDurationMs: Math.round(input.probeDurationMs),
		snapshot: {
			environment: snapshot.environment,
			logicalCpuCount: snapshot.logicalCpuCount,
			effectiveAvailableMemoryMiB: toMiB(effectiveAvailableMemoryBytes(snapshot)),
			processAvailableMemoryMiB: toMiB(snapshot.processAvailableMemoryBytes),
			constrainedMemoryMiB: toMiB(snapshot.constrainedMemoryBytes),
			hostFreeMemoryMiB: toMiB(snapshot.hostFreeMemoryBytes),
			hostTotalMemoryMiB: toMiB(snapshot.hostTotalMemoryBytes),
			workspaceAvailableMiB: toMiB(snapshot.workspaceAvailableBytes),
			heapUsedRatio: heapRatio === null ? null : Number(heapRatio.toFixed(4)),
			systemCpuPercent: snapshot.systemCpuPercent,
			diagnostics: snapshot.diagnostics,
		},
		settingsErrors: resolved.errors,
	};
}

const MIB = 1024 * 1024;

function toMiB(bytes: number | null): number | null {
	return bytes === null ? null : Math.round(bytes / MIB);
}

function formatMiB(bytes: number | null): string {
	const mib = toMiB(bytes);
	return mib === null ? "unknown" : `${mib.toLocaleString()} MiB`;
}
