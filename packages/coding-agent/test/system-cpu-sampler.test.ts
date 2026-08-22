import { describe, expect, it } from "vitest";
import {
	computeCpuBusyPercent,
	DEFAULT_CPU_SAMPLE_MS,
	MAX_CPU_SAMPLE_MS,
	MIN_CPU_SAMPLE_MS,
	readSystemCpuTimes,
	type SystemCpuTimes,
	sampleSystemCpuPercent,
} from "../src/core/system-cpu-sampler.ts";

describe("computeCpuBusyPercent", () => {
	it("computes busy percent from a two-sample delta", () => {
		const first: SystemCpuTimes = { idle: 100, total: 200 };
		const second: SystemCpuTimes = { idle: 160, total: 300 };
		// totalDelta=100, idleDelta=60 -> 40% busy.
		expect(computeCpuBusyPercent(first, second)).toBe(40);
	});

	it("returns null for a zero or negative total delta", () => {
		expect(computeCpuBusyPercent({ idle: 0, total: 100 }, { idle: 0, total: 100 })).toBeNull();
		expect(computeCpuBusyPercent({ idle: 0, total: 200 }, { idle: 0, total: 100 })).toBeNull();
	});

	it("returns null for non-finite inputs", () => {
		expect(computeCpuBusyPercent({ idle: Number.NaN, total: 100 }, { idle: 0, total: 200 })).toBeNull();
		expect(computeCpuBusyPercent({ idle: 0, total: 100 }, { idle: 0, total: Number.POSITIVE_INFINITY })).toBeNull();
	});

	it("clamps the result into [0, 100]", () => {
		// idle went backwards (counter anomaly) -> raw 150% -> clamped 100.
		expect(computeCpuBusyPercent({ idle: 100, total: 200 }, { idle: 50, total: 300 })).toBe(100);
		// idle grew faster than total (counter anomaly) -> raw negative -> clamped 0.
		expect(computeCpuBusyPercent({ idle: 100, total: 200 }, { idle: 300, total: 300 })).toBe(0);
	});
});

describe("sampleSystemCpuPercent", () => {
	function sequenceReader(samples: ReadonlyArray<SystemCpuTimes | null>): () => SystemCpuTimes | null {
		let index = 0;
		return () => {
			const sample = samples[Math.min(index, samples.length - 1)];
			index += 1;
			return sample;
		};
	}

	it("takes a two-read fixed-interval delta", async () => {
		const slept: number[] = [];
		const percent = await sampleSystemCpuPercent({
			readCpuTimes: sequenceReader([
				{ idle: 1000, total: 2000 },
				{ idle: 1100, total: 2400 },
			]),
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		// totalDelta=400, idleDelta=100 -> 75% busy.
		expect(percent).toBe(75);
		expect(slept).toEqual([DEFAULT_CPU_SAMPLE_MS]);
	});

	it("clamps the sample interval into the roadmap §6.3 fixed range [150, 250] ms", async () => {
		const slept: number[] = [];
		const sleep = async (ms: number): Promise<void> => {
			slept.push(ms);
		};
		const reader = () => ({ idle: 0, total: 1 });
		await sampleSystemCpuPercent({
			sampleMs: 10,
			readCpuTimes: sequenceReader([
				{ idle: 0, total: 0 },
				{ idle: 0, total: 1 },
			]),
			sleep,
		});
		await sampleSystemCpuPercent({ sampleMs: 10_000, readCpuTimes: reader, sleep });
		await sampleSystemCpuPercent({ sampleMs: Number.NaN, readCpuTimes: reader, sleep });
		expect(slept).toEqual([MIN_CPU_SAMPLE_MS, MAX_CPU_SAMPLE_MS, DEFAULT_CPU_SAMPLE_MS]);
	});

	it("resolves null instead of throwing when the reader throws", async () => {
		await expect(
			sampleSystemCpuPercent({
				readCpuTimes: () => {
					throw new Error("cpu probe unavailable");
				},
				sleep: async () => {},
			}),
		).resolves.toBeNull();
	});

	it("resolves null when either read is unavailable", async () => {
		await expect(
			sampleSystemCpuPercent({ readCpuTimes: sequenceReader([null]), sleep: async () => {} }),
		).resolves.toBeNull();
		await expect(
			sampleSystemCpuPercent({
				readCpuTimes: sequenceReader([{ idle: 0, total: 100 }, null]),
				sleep: async () => {},
			}),
		).resolves.toBeNull();
	});

	it("resolves null when the sleep dependency rejects", async () => {
		await expect(
			sampleSystemCpuPercent({
				readCpuTimes: sequenceReader([{ idle: 0, total: 100 }]),
				sleep: () => Promise.reject(new Error("timer failure")),
			}),
		).resolves.toBeNull();
	});
});

describe("readSystemCpuTimes", () => {
	it("returns aggregated finite jiffies or null on this host", () => {
		const times = readSystemCpuTimes();
		if (times !== null) {
			expect(Number.isFinite(times.idle)).toBe(true);
			expect(Number.isFinite(times.total)).toBe(true);
			expect(times.total).toBeGreaterThanOrEqual(times.idle);
		}
	});
});
