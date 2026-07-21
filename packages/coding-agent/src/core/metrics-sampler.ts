import * as os from "node:os";

const DEFAULT_EMA_ALPHA = 0.3;
const DEFAULT_CPU_HISTORY_SIZE = 120;
const DEFAULT_ROLLING_WINDOW_SIZE = 5;
const DEFAULT_SPIKE_THRESHOLD = 80;
const MIN_CPU_HISTORY_SIZE = 1;
const MAX_CPU_HISTORY_SIZE = 120;
const MIN_SPIKE_THRESHOLD = 0;
const MAX_SPIKE_THRESHOLD = 100;

type MetricsSamplerOptions = {
	now?: () => number;
	readCpu?: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
	readMemory?: () => { rss: number };
	readSystemCpuTimes?: () => { idle: number; total: number };
	readSystemMemory?: () => { total: number; free: number };
	cpuCount?: number;
	emaAlpha?: number;
	historySize?: number;
	rollingWindowSize?: number;
	spikeThreshold?: number;
};

/**
 * Samples process CPU and memory usage on a fixed interval.
 *
 * CPU% is computed from `process.cpuUsage(prev)` deltas normalized by elapsed
 * wall-clock time and the number of logical CPUs. The raw delta percent is
 * then smoothed with an exponential moving average (EMA). Memory is read from
 * `process.memoryUsage().rss`.
 *
 * The interval timer is `unref()`-ed so it never keeps the process alive.
 */
export class MetricsSampler {
	private readonly now: () => number;
	private readonly readCpu: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
	private readonly readMemory: () => { rss: number };
	private readonly readSystemCpuTimes: () => { idle: number; total: number };
	private readonly readSystemMemory: () => { total: number; free: number };

	private timer: ReturnType<typeof setInterval> | null = null;
	private prevCpu: NodeJS.CpuUsage | null = null;
	private prevTime: number | null = null;
	private cpuPercent: number | null = null;
	private memoryRssBytes: number | null = null;
	private cpuCount: number;
	private cpuPeak: number | null = null;
	private readonly smoothedHistory: number[] = [];
	private readonly emaAlpha: number;
	private readonly historySize: number;
	private readonly rollingWindowSize: number;
	private readonly spikeThreshold: number;
	private cpuSpikeCount = 0;
	private wasCpuSpike = false;
	private prevSysCpu: { idle: number; total: number } | null = null;
	private systemCpuPercent: number | null = null;
	private systemMemoryUsedBytes: number | null = null;
	private systemMemoryTotalBytes: number | null = null;

	/**
	 * Create a sampler. All dependencies can be injected for deterministic
	 * testing; omitted options default to real process/OS sources.
	 */
	constructor(options?: MetricsSamplerOptions) {
		this.now = options?.now ?? (() => Date.now());
		this.readCpu = options?.readCpu ?? ((prev?: NodeJS.CpuUsage) => process.cpuUsage(prev));
		this.readMemory = options?.readMemory ?? (() => process.memoryUsage());
		this.cpuCount = sanitizeInteger(options?.cpuCount, os.cpus().length, 1, Number.MAX_SAFE_INTEGER);
		this.emaAlpha = sanitizeNumber(options?.emaAlpha, DEFAULT_EMA_ALPHA, 0, 1);
		this.historySize = sanitizeInteger(
			options?.historySize,
			DEFAULT_CPU_HISTORY_SIZE,
			MIN_CPU_HISTORY_SIZE,
			MAX_CPU_HISTORY_SIZE,
		);
		this.rollingWindowSize = sanitizeInteger(
			options?.rollingWindowSize,
			Math.min(DEFAULT_ROLLING_WINDOW_SIZE, this.historySize),
			MIN_CPU_HISTORY_SIZE,
			this.historySize,
		);
		this.spikeThreshold = sanitizeNumber(
			options?.spikeThreshold,
			DEFAULT_SPIKE_THRESHOLD,
			MIN_SPIKE_THRESHOLD,
			MAX_SPIKE_THRESHOLD,
		);
		this.readSystemCpuTimes = options?.readSystemCpuTimes ?? (() => readOsCpuTimes());
		this.readSystemMemory = options?.readSystemMemory ?? (() => ({ total: os.totalmem(), free: os.freemem() }));
	}

	/**
	 * Start sampling. If already running, the existing timer is stopped and
	 * restarted with the new interval.
	 */
	start(intervalMs = 2000): void {
		this.stop();
		this.prevCpu = this.readCpu();
		this.prevTime = this.now();
		this.cpuPercent = null;
		this.memoryRssBytes = null;
		this.prevSysCpu = this.readSystemCpuTimes();
		this.systemCpuPercent = null;
		this.systemMemoryUsedBytes = null;
		this.systemMemoryTotalBytes = null;
		this.cpuPeak = null;
		this.cpuSpikeCount = 0;
		this.wasCpuSpike = false;
		this.smoothedHistory.length = 0;

		this.timer = setInterval(() => this.sample(), intervalMs);
		this.timer.unref();
	}

	/** Stop sampling and reset all cached values to `null`. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.prevCpu = null;
		this.prevTime = null;
		this.cpuPercent = null;
		this.memoryRssBytes = null;
		this.cpuPeak = null;
		this.cpuSpikeCount = 0;
		this.wasCpuSpike = false;
		this.prevSysCpu = null;
		this.systemCpuPercent = null;
		this.systemMemoryUsedBytes = null;
		this.systemMemoryTotalBytes = null;
		this.smoothedHistory.length = 0;
	}

	/** The most recently sampled, EMA-smoothed CPU percent (0-100), or `null` before the first sample. */
	getCpuPercent(): number | null {
		return this.cpuPercent;
	}

	/** The most recently sampled RSS memory size in bytes, or `null` before the first sample. */
	getMemoryRssBytes(): number | null {
		return this.memoryRssBytes;
	}

	/** System-wide CPU busy percent (0-100) across all cores, or `null` before the first sample. */
	getSystemCpuPercent(): number | null {
		return this.systemCpuPercent;
	}

	/** System-wide used memory in bytes (total - free), or `null` before the first sample. */
	getSystemMemoryUsedBytes(): number | null {
		return this.systemMemoryUsedBytes;
	}

	/** System total physical memory in bytes, or `null` before the first sample. */
	getSystemMemoryTotalBytes(): number | null {
		return this.systemMemoryTotalBytes;
	}

	/** The highest smoothed CPU percent observed since start, or `null` before the first sample. */
	getCpuPeak(): number | null {
		return this.cpuPeak;
	}

	getCpuSpikeCount(): number {
		return this.cpuSpikeCount;
	}

	/**
	 * The mean of the last `window` smoothed CPU percent samples, or `null` if
	 * fewer than `window` samples have been collected.
	 */
	getCpuRollingAvg(window = this.rollingWindowSize): number | null {
		if (!Number.isFinite(window) || window <= 0) {
			return null;
		}
		const sampleWindow = Math.floor(window);
		if (this.smoothedHistory.length < sampleWindow) {
			return null;
		}
		const start = this.smoothedHistory.length - sampleWindow;
		let sum = 0;
		for (let i = start; i < this.smoothedHistory.length; i++) {
			sum += this.smoothedHistory[i];
		}
		return sum / sampleWindow;
	}

	private sample(): void {
		if (!this.prevCpu || this.prevTime === null) {
			return;
		}

		const now = this.now();
		const elapsedMs = now - this.prevTime;
		if (elapsedMs <= 0) {
			return;
		}

		const delta = this.readCpu(this.prevCpu);
		const deltaMicroseconds = delta.user + delta.system;

		// Convert microseconds of CPU time into a percentage of total CPU capacity.
		// One core-second per elapsed wall second is 100% of one core; dividing by
		// cpuCount gives the percentage of total system CPU capacity.
		const coreFraction = deltaMicroseconds / (elapsedMs * 1000);
		const rawPercent = (coreFraction / this.cpuCount) * 100;
		const clampedRaw = clamp(rawPercent, 0, 100);

		// First sample seeds the EMA; subsequent samples blend with prior value.
		const smoothed =
			this.cpuPercent === null ? clampedRaw : this.emaAlpha * clampedRaw + (1 - this.emaAlpha) * this.cpuPercent;

		this.cpuPercent = smoothed;
		this.memoryRssBytes = this.readMemory().rss;

		// System-wide sampling (whole computer): CPU busy% from os.cpus() time
		// deltas, memory from totalmem/freemem.
		if (this.prevSysCpu) {
			const sys = this.readSystemCpuTimes();
			const totalDelta = sys.total - this.prevSysCpu.total;
			const idleDelta = sys.idle - this.prevSysCpu.idle;
			if (totalDelta > 0) {
				this.systemCpuPercent = clamp(((totalDelta - idleDelta) / totalDelta) * 100, 0, 100);
			}
			this.prevSysCpu = sys;
		}
		const sysMem = this.readSystemMemory();
		this.systemMemoryTotalBytes = sysMem.total;
		this.systemMemoryUsedBytes = Math.max(0, sysMem.total - sysMem.free);

		this.smoothedHistory.push(smoothed);
		if (this.smoothedHistory.length > this.historySize) {
			this.smoothedHistory.shift();
		}
		if (this.cpuPeak === null || smoothed > this.cpuPeak) {
			this.cpuPeak = smoothed;
		}
		const isCpuSpike = smoothed > this.spikeThreshold;
		if (isCpuSpike && !this.wasCpuSpike) {
			this.cpuSpikeCount++;
		}
		this.wasCpuSpike = isCpuSpike;

		// Accumulate the delta so the next sample computes from the same baseline.
		this.prevCpu = {
			user: this.prevCpu.user + delta.user,
			system: this.prevCpu.system + delta.system,
		};
		this.prevTime = now;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** Aggregate os.cpus() times into { idle, total } jiffies (ms) across all cores. */
function readOsCpuTimes(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		idle += cpu.times.idle;
		total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
	}
	return { idle, total };
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return clamp(value, min, max);
}

function sanitizeInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.floor(clamp(value, min, max));
}
