import * as os from "node:os";

/**
 * System-wide CPU sampling primitive for the resource-aware runtime
 * (OMK v0.97.x roadmap §6.3, M1 "system CPU primitive 추출").
 *
 * This module is a pure measurement primitive: it never throws, holds no
 * timers between calls, and every dependency is injectable for deterministic
 * tests. Consumers (host resource probe, admission policy) treat `null` as
 * "unavailable" and degrade conservatively.
 */

/** Aggregated CPU jiffies across all logical cores. */
export interface SystemCpuTimes {
	readonly idle: number;
	readonly total: number;
}

/** Roadmap §6.3: the CPU probe uses a fixed interval between 150 ms and 250 ms. */
export const MIN_CPU_SAMPLE_MS = 150;
export const MAX_CPU_SAMPLE_MS = 250;
export const DEFAULT_CPU_SAMPLE_MS = 180;

export type SystemCpuSampleOptions = {
	/** Fixed sample interval; clamped into `[150, 250]` ms per roadmap §6.3. */
	sampleMs?: number;
	/** Injectable jiffies reader. Returning `null` or throwing yields a `null` sample. */
	readCpuTimes?: () => SystemCpuTimes | null;
	/** Injectable sleep for deterministic tests. The default sleep stays ref'd so an awaited sample always settles. */
	sleep?: (ms: number) => Promise<void>;
};

/**
 * Aggregate `os.cpus()` times into `{ idle, total }` jiffies across all cores.
 * Returns `null` instead of throwing when the OS probe is unavailable.
 */
export function readSystemCpuTimes(): SystemCpuTimes | null {
	try {
		const cpus = os.cpus();
		if (!Array.isArray(cpus) || cpus.length === 0) {
			return null;
		}
		let idle = 0;
		let total = 0;
		for (const cpu of cpus) {
			idle += cpu.times.idle;
			total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
		}
		return { idle, total };
	} catch {
		return null;
	}
}

/**
 * Busy percent (0-100) from a two-sample jiffies delta, or `null` when the
 * delta is unusable (non-finite input, zero or negative elapsed total).
 */
export function computeCpuBusyPercent(first: SystemCpuTimes, second: SystemCpuTimes): number | null {
	if (
		!Number.isFinite(first.idle) ||
		!Number.isFinite(first.total) ||
		!Number.isFinite(second.idle) ||
		!Number.isFinite(second.total)
	) {
		return null;
	}
	const totalDelta = second.total - first.total;
	if (totalDelta <= 0) {
		return null;
	}
	const idleDelta = second.idle - first.idle;
	const busyPercent = ((totalDelta - idleDelta) / totalDelta) * 100;
	return clamp(busyPercent, 0, 100);
}

/**
 * Take one system CPU busy% sample using a two-read fixed-interval delta
 * (roadmap §6.3 `os.cpus()` two-sample delta).
 *
 * Never rejects: probe failures resolve to `null` so a resource probe error
 * cannot propagate into an OMK process crash (roadmap §2.1).
 */
export async function sampleSystemCpuPercent(options?: SystemCpuSampleOptions): Promise<number | null> {
	const sampleMs = clampInteger(options?.sampleMs, DEFAULT_CPU_SAMPLE_MS, MIN_CPU_SAMPLE_MS, MAX_CPU_SAMPLE_MS);
	const readTimes = options?.readCpuTimes ?? readSystemCpuTimes;
	const sleep = options?.sleep ?? boundedSleep;
	try {
		const first = readTimes();
		if (first === null) {
			return null;
		}
		await sleep(sampleMs);
		const second = readTimes();
		if (second === null) {
			return null;
		}
		return computeCpuBusyPercent(first, second);
	} catch {
		return null;
	}
}

/**
 * Bounded one-shot sleep for an actively awaited sample. Deliberately NOT
 * `unref()`-ed: if this were the only pending work (e.g. a headless doctor
 * CLI awaiting one probe), an unref'd timer would let the process exit with
 * an unsettled await. Background continuous samplers that must not keep the
 * process alive inject their own sleep instead.
 */
function boundedSleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.floor(clamp(value, min, max));
}
