import * as fs from "node:fs";
import * as os from "node:os";
import * as v8 from "node:v8";
import {
	DEFAULT_CPU_SAMPLE_MS,
	MAX_CPU_SAMPLE_MS,
	MIN_CPU_SAMPLE_MS,
	sampleSystemCpuPercent,
} from "./system-cpu-sampler.ts";

export { DEFAULT_CPU_SAMPLE_MS, MAX_CPU_SAMPLE_MS, MIN_CPU_SAMPLE_MS };

/** Diagnostic hint only — admission authority comes from measured values (§4.1). */
export type HostEnvironment = "native" | "wsl" | "container" | "unknown";

/** Injectable probe sources for deterministic, fault-injectable tests. */
export interface HostResourceProbeIo {
	readonly platform: () => NodeJS.Platform;
	readonly arch: () => string;
	readonly cpuCount: () => number;
	readonly availableMemory: () => number | null | undefined;
	readonly constrainedMemory: () => number | null | undefined;
	readonly totalmem: () => number;
	readonly freemem: () => number;
	readonly rssBytes: () => number;
	readonly heapStatistics: () => { readonly heapUsedBytes: number; readonly heapLimitBytes: number };
	readonly statfs: (target: string) => Promise<{ readonly bavail: bigint; readonly bsize: bigint }>;
	readonly sampleSystemCpuPercent: (sampleMs: number) => Promise<number | null>;
	readonly osRelease: () => string;
	readonly fileExists: (target: string) => boolean;
}

export type HostResourceProbeOptions = {
	/** Workspace directory for the disk probe. Used for measurement only; never recorded. */
	cwd?: string;
	/** Hard preflight deadline for async probes; default 300 ms, clamped `[50, 5000]` (§6.3, §18.1). */
	maxProbeMs?: number;
	/** CPU two-sample interval; clamped `[150, 250]` ms (§6.3). */
	cpuSampleMs?: number;
	/** Injectable clock for a deterministic `observedAt`. */
	now?: () => Date;
	/** Partial probe source overrides; unspecified sources use real process/OS reads. */
	io?: Partial<HostResourceProbeIo>;
};

export const DEFAULT_MAX_PROBE_MS = 300;
export const MIN_MAX_PROBE_MS = 50;
export const MAX_MAX_PROBE_MS = 5000;

export function defaultProbeIo(): HostResourceProbeIo {
	return {
		platform: () => process.platform,
		arch: () => process.arch,
		cpuCount: () => os.cpus().length,
		availableMemory: () => (typeof process.availableMemory === "function" ? process.availableMemory() : null),
		constrainedMemory: () => (typeof process.constrainedMemory === "function" ? process.constrainedMemory() : null),
		totalmem: () => os.totalmem(),
		freemem: () => os.freemem(),
		rssBytes: () => process.memoryUsage().rss,
		heapStatistics: () => {
			const stats = v8.getHeapStatistics();
			return { heapUsedBytes: stats.used_heap_size, heapLimitBytes: stats.heap_size_limit };
		},
		statfs: async (target) => {
			const stats = await fs.promises.statfs(target, { bigint: true });
			return { bavail: stats.bavail, bsize: stats.bsize };
		},
		sampleSystemCpuPercent: (sampleMs) => sampleSystemCpuPercent({ sampleMs }),
		osRelease: () => os.release(),
		fileExists: (target) => fs.existsSync(target),
	};
}

/** Coarse environment hint (§4.1). Never an admission authority; `unknown` on any probe error. */
export function detectEnvironment(io: HostResourceProbeIo): HostEnvironment {
	try {
		if (io.platform() === "linux") {
			if (/microsoft/i.test(io.osRelease())) {
				return "wsl";
			}
			if (io.fileExists("/.dockerenv") || io.fileExists("/run/.containerenv")) {
				return "container";
			}
		}
		return "native";
	} catch {
		return "unknown";
	}
}

type DeadlineResult<T> = { readonly value: T | null; readonly timedOut: boolean; readonly failed: boolean };

/**
 * Race `run()` against a hard deadline. Never rejects. The bounded deadline
 * timer is intentionally ref'd (see module doc) and cleared once settled, so
 * no timer outlives the probe.
 */
export async function raceDeadline<T>(run: () => Promise<T>, deadlineMs: number): Promise<DeadlineResult<T>> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), Math.max(1, deadlineMs));
		});
		const work = Promise.resolve()
			.then(run)
			.then(
				(value): DeadlineResult<T> => ({ value, timedOut: false, failed: false }),
				(): DeadlineResult<T> => ({ value: null, timedOut: false, failed: true }),
			);
		const settled = await Promise.race([work, timeout]);
		if (settled === "timeout") {
			return { value: null, timedOut: true, failed: false };
		}
		return settled;
	} finally {
		if (timer !== null) {
			clearTimeout(timer);
		}
	}
}

/** `bavail * bsize` with BigInt overflow clamped to `Number.MAX_SAFE_INTEGER` (§6.5). */
export function bigintProductToSafeNumber(a: bigint, b: bigint): number | null {
	if (a < 0n || b < 0n) {
		return null;
	}
	const product = a * b;
	const max = BigInt(Number.MAX_SAFE_INTEGER);
	return Number(product > max ? max : product);
}

export function guardValue<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

export function probePositiveNumber(
	read: () => number | null | undefined,
	diagnostics: string[],
	code: string,
): number | null {
	try {
		const value = read();
		// Values above MAX_SAFE_INTEGER are "no limit" sentinels, not real byte
		// counts — observed on WSL where process.constrainedMemory() reports the
		// cgroup u64 max (2^64). §6.4: unclear OS semantics degrade to a
		// diagnostic instead of entering the candidate set.
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
			diagnostics.push(code);
			return null;
		}
		return value;
	} catch {
		diagnostics.push(code);
		return null;
	}
}

export function probePositiveInteger(read: () => number, diagnostics: string[], code: string): number | null {
	const value = probePositiveNumber(read, diagnostics, code);
	return value === null ? null : Math.floor(value);
}

export function sanitizeNonNegative(value: number | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return value;
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.floor(Math.max(min, Math.min(max, value)));
}
