import { createHash } from "node:crypto";
import {
	bigintProductToSafeNumber,
	clampInteger,
	DEFAULT_CPU_SAMPLE_MS,
	DEFAULT_MAX_PROBE_MS,
	defaultProbeIo,
	detectEnvironment,
	guardValue,
	type HostEnvironment,
	type HostResourceProbeIo,
	type HostResourceProbeOptions,
	MAX_CPU_SAMPLE_MS,
	MAX_MAX_PROBE_MS,
	MIN_CPU_SAMPLE_MS,
	MIN_MAX_PROBE_MS,
	probePositiveInteger,
	probePositiveNumber,
	raceDeadline,
	sanitizeNonNegative,
} from "./host-resource-probe.ts";

export { DEFAULT_MAX_PROBE_MS, MAX_MAX_PROBE_MS, MIN_MAX_PROBE_MS };
export type { HostEnvironment, HostResourceProbeIo, HostResourceProbeOptions };

/**
 * Host resource snapshot probe (OMK v0.97.x roadmap §6, M1/PR1).
 *
 * The snapshot is an immutable operational fact captured before a prompt run.
 * It is observability-first in this layer: no admission or scheduler behavior
 * changes here (that wiring lands in later milestones).
 *
 * Invariants enforced by this module:
 * - Never throws: every probe source is individually guarded and a failure
 *   degrades to `null` plus a bounded diagnostic code (roadmap §2.1, §21).
 * - Bounded latency: async probes race a hard deadline (default 300 ms,
 *   roadmap §6.3). Deadline timers stay ref'd while the probe is awaited so
 *   the returned promise always settles even when it is the only pending
 *   work in the process (headless CLI probes), and are cleared on settle.
 * - Privacy boundary (roadmap §6.2): the snapshot carries only numeric
 *   capacity facts, platform/arch, a coarse environment hint, and bounded
 *   diagnostic codes. No username, hostname, paths, env dump, mounts,
 *   network interfaces, machine identifiers, or file contents.
 */

export const HOST_RESOURCE_SNAPSHOT_VERSION = 1 as const;

export interface HostResourceSnapshot {
	readonly schemaVersion: typeof HOST_RESOURCE_SNAPSHOT_VERSION;
	readonly observedAt: string;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly logicalCpuCount: number;

	readonly processAvailableMemoryBytes: number | null;
	readonly constrainedMemoryBytes: number | null;
	readonly hostTotalMemoryBytes: number | null;
	readonly hostFreeMemoryBytes: number | null;

	readonly processRssBytes: number;
	readonly heapUsedBytes: number;
	readonly heapLimitBytes: number;

	readonly systemCpuPercent: number | null;
	readonly workspaceAvailableBytes: number | null;

	readonly environment: HostEnvironment;
	readonly diagnostics: readonly string[];
}

/**
 * Capture a host resource snapshot. Resolves within roughly `maxProbeMs` and
 * never rejects; unavailable sources yield `null` fields plus diagnostics.
 */
export async function captureHostResourceSnapshot(options?: HostResourceProbeOptions): Promise<HostResourceSnapshot> {
	const io: HostResourceProbeIo = { ...defaultProbeIo(), ...options?.io };
	const maxProbeMs = clampInteger(options?.maxProbeMs, DEFAULT_MAX_PROBE_MS, MIN_MAX_PROBE_MS, MAX_MAX_PROBE_MS);
	const cpuSampleMs = clampInteger(options?.cpuSampleMs, DEFAULT_CPU_SAMPLE_MS, MIN_CPU_SAMPLE_MS, MAX_CPU_SAMPLE_MS);
	const diagnostics: string[] = [];

	const observedAt = guardValue(() => (options?.now?.() ?? new Date()).toISOString(), new Date(0).toISOString());
	const platform = guardValue<NodeJS.Platform>(() => io.platform(), "linux");
	const arch = guardValue(() => io.arch(), "unknown");
	const logicalCpuCount = Math.max(
		1,
		probePositiveInteger(() => io.cpuCount(), diagnostics, "probe.cpu-count.unavailable") ?? 1,
	);

	// Memory semantics note (§6.4): `process.availableMemory()` is free memory
	// still available to the process; `process.constrainedMemory()` is the OS
	// limit (0 when unknown, and on some platforms it includes current RSS).
	// We record raw values and never subtract RSS from them, so the min-known
	// policy stays conservative without double subtraction.
	const processAvailableMemoryBytes = probePositiveNumber(
		() => io.availableMemory(),
		diagnostics,
		"probe.available-memory.unavailable",
	);
	const constrainedMemoryBytes = probePositiveNumber(
		() => io.constrainedMemory(),
		diagnostics,
		"probe.constrained-memory.unavailable",
	);
	const hostTotalMemoryBytes = probePositiveNumber(
		() => io.totalmem(),
		diagnostics,
		"probe.host-total-memory.unavailable",
	);
	const hostFreeMemoryBytes = probePositiveNumber(
		() => io.freemem(),
		diagnostics,
		"probe.host-free-memory.unavailable",
	);

	const processRssBytes = probePositiveNumber(() => io.rssBytes(), diagnostics, "probe.rss.unavailable") ?? 0;
	const heap = guardValue(() => io.heapStatistics(), null);
	if (heap === null) {
		diagnostics.push("probe.heap.unavailable");
	}
	const heapUsedBytes = sanitizeNonNegative(heap?.heapUsedBytes) ?? 0;
	const heapLimitBytes = sanitizeNonNegative(heap?.heapLimitBytes) ?? 0;

	// Async probes share one deadline and run concurrently so total preflight
	// wall time stays ~= maxProbeMs (roadmap §24: p95 <= 300 ms).
	const [disk, cpu] = await Promise.all([
		raceDeadline(() => io.statfs(options?.cwd ?? guardValue(() => process.cwd(), ".")), maxProbeMs),
		raceDeadline(() => io.sampleSystemCpuPercent(cpuSampleMs), maxProbeMs),
	]);

	let workspaceAvailableBytes: number | null = null;
	if (disk.timedOut) {
		diagnostics.push("probe.disk.timeout");
	} else if (disk.failed || disk.value === null) {
		diagnostics.push("probe.disk.unavailable");
	} else {
		// §6.5: bavail (unprivileged-available), never bfree; clamp before Number().
		workspaceAvailableBytes = bigintProductToSafeNumber(disk.value.bavail, disk.value.bsize);
		if (workspaceAvailableBytes === null) {
			diagnostics.push("probe.disk.unavailable");
		}
	}

	let systemCpuPercent: number | null = null;
	if (cpu.timedOut) {
		diagnostics.push("probe.cpu.timeout");
	} else if (cpu.failed || cpu.value === null || !Number.isFinite(cpu.value)) {
		diagnostics.push("probe.cpu.unavailable");
	} else {
		systemCpuPercent = Math.max(0, Math.min(100, cpu.value));
	}

	return {
		schemaVersion: HOST_RESOURCE_SNAPSHOT_VERSION,
		observedAt,
		platform,
		arch,
		logicalCpuCount,
		processAvailableMemoryBytes,
		constrainedMemoryBytes,
		hostTotalMemoryBytes,
		hostFreeMemoryBytes,
		processRssBytes,
		heapUsedBytes,
		heapLimitBytes,
		systemCpuPercent,
		workspaceAvailableBytes,
		environment: detectEnvironment(io),
		diagnostics,
	};
}

/**
 * §6.4 effective memory: the minimum of the known positive candidates
 * (process available, constrained, host free), or `null` when none is known.
 */
export function effectiveAvailableMemoryBytes(snapshot: HostResourceSnapshot): number | null {
	const candidates = [
		snapshot.processAvailableMemoryBytes,
		snapshot.constrainedMemoryBytes,
		snapshot.hostFreeMemoryBytes,
	].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
	if (candidates.length === 0) {
		return null;
	}
	return Math.min(...candidates);
}

/** Stable content digest of a snapshot (used as `snapshotDigest` in admission decisions). */
export function computeHostResourceSnapshotDigest(snapshot: HostResourceSnapshot): string {
	const canonical = JSON.stringify([
		snapshot.schemaVersion,
		snapshot.observedAt,
		snapshot.platform,
		snapshot.arch,
		snapshot.logicalCpuCount,
		snapshot.processAvailableMemoryBytes,
		snapshot.constrainedMemoryBytes,
		snapshot.hostTotalMemoryBytes,
		snapshot.hostFreeMemoryBytes,
		snapshot.processRssBytes,
		snapshot.heapUsedBytes,
		snapshot.heapLimitBytes,
		snapshot.systemCpuPercent,
		snapshot.workspaceAvailableBytes,
		snapshot.environment,
		snapshot.diagnostics,
	]);
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}
