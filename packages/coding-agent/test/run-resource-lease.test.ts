import { describe, expect, it } from "vitest";
import type { ResourceAdmissionDecision } from "../src/core/resource-admission.ts";
import {
	effectiveLeaseCap,
	RunResourceLeaseController,
	type ToolCapAuthority,
} from "../src/core/run-resource-lease.ts";

function decision(maxToolConcurrency: number): ResourceAdmissionDecision {
	return {
		schemaVersion: 1,
		decisionId: `res-adm-test-${maxToolConcurrency}`,
		snapshotDigest: "digest",
		pressure: maxToolConcurrency >= 4 ? "normal" : maxToolConcurrency >= 2 ? "constrained" : "critical",
		action: maxToolConcurrency >= 4 ? "allow" : maxToolConcurrency >= 2 ? "throttle" : "defer-heavy",
		maxToolConcurrency,
		maxParallelLanes: maxToolConcurrency,
		maxHeavyProcesses: 1,
		reasons: [],
		decidedAt: "2026-08-21T00:00:00.000Z",
	};
}

function capAuthority(initial: number | undefined): ToolCapAuthority & { readonly history: (number | undefined)[] } {
	let cap = initial;
	const history: (number | undefined)[] = [];
	return {
		history,
		getCap: () => cap,
		setCap: (next) => {
			cap = next;
			history.push(next);
		},
	};
}

describe("RunResourceLeaseController", () => {
	it("applies min(baseline, admission) during the lease and restores the baseline on release (§7.3, §8.3)", () => {
		const authority = capAuthority(4);
		const controller = new RunResourceLeaseController(authority);
		const lease = controller.acquire({ promptRunId: "run-1", decision: decision(2) });
		expect(authority.getCap()).toBe(2);
		expect(controller.isCurrent(lease)).toBe(true);
		expect(controller.release(lease)).toBe("restored");
		expect(authority.getCap()).toBe(4);
		expect(controller.activeLease).toBeNull();
	});

	it("limits an unlimited baseline (undefined) to the admission cap (§7.3 zero-means-unlimited)", () => {
		const authority = capAuthority(undefined);
		const controller = new RunResourceLeaseController(authority);
		const lease = controller.acquire({ promptRunId: "run-1", decision: decision(4) });
		expect(authority.getCap()).toBe(4);
		controller.release(lease);
		expect(authority.getCap()).toBeUndefined();
	});

	it("never raises a configured baseline below the admission cap (M2 exit criterion)", () => {
		const authority = capAuthority(1);
		const controller = new RunResourceLeaseController(authority);
		const lease = controller.acquire({ promptRunId: "run-1", decision: decision(4) });
		expect(authority.getCap()).toBe(1);
		controller.release(lease);
		expect(authority.getCap()).toBe(1);
	});

	it("treats duplicate release as a diagnosable no-op (§8.3 exactly-once)", () => {
		const authority = capAuthority(4);
		const controller = new RunResourceLeaseController(authority);
		const lease = controller.acquire({ promptRunId: "run-1", decision: decision(2) });
		expect(controller.release(lease)).toBe("restored");
		expect(controller.release(lease)).toBe("duplicate");
		expect(authority.getCap()).toBe(4);
		expect(controller.staleReleaseCount).toBe(1);
	});

	it("ignores a stale release from a superseded run (§8.1 retry-outlives-finally race)", () => {
		const authority = capAuthority(4);
		const controller = new RunResourceLeaseController(authority);
		const first = controller.acquire({ promptRunId: "run-1", decision: decision(2) });
		const second = controller.acquire({ promptRunId: "run-2", decision: decision(1) });
		expect(authority.getCap()).toBe(1);

		// First run's finally fires late: it must not clobber the newer cap.
		expect(controller.release(first)).toBe("stale");
		expect(authority.getCap()).toBe(1);
		expect(controller.isCurrent(second)).toBe(true);

		expect(controller.release(second)).toBe("restored");
		expect(authority.getCap()).toBe(4);
	});

	it("captures the baseline once per idle→active transition (§8.1 nested-continuation race)", () => {
		const authority = capAuthority(4);
		const controller = new RunResourceLeaseController(authority);
		const first = controller.acquire({ promptRunId: "run-1", decision: decision(2) });
		// Overlapping acquire while throttled to 2: baseline must stay 4, not 2.
		const second = controller.acquire({ promptRunId: "run-2", decision: decision(3) });
		expect(authority.getCap()).toBe(3);
		controller.release(first);
		expect(controller.release(second)).toBe("restored");
		expect(authority.getCap()).toBe(4);
	});

	it("keeps generations strictly monotonic", () => {
		const authority = capAuthority(4);
		const controller = new RunResourceLeaseController(authority);
		const generations: number[] = [];
		for (let i = 0; i < 5; i++) {
			const lease = controller.acquire({ promptRunId: `run-${i}`, decision: decision(2) });
			generations.push(lease.generation);
			controller.release(lease);
		}
		expect(generations).toEqual([1, 2, 3, 4, 5]);
	});

	it("property (§23.2 seed 0x0fc52026): random interleavings never exceed the baseline and always restore it", () => {
		const random = mulberry32(0x0fc52026);
		for (let iteration = 0; iteration < 200; iteration++) {
			const baseline = randInt(random, 0, 8) === 0 ? undefined : randInt(random, 1, 8);
			const authority = capAuthority(baseline);
			const controller = new RunResourceLeaseController(authority);
			const open: ReturnType<RunResourceLeaseController["acquire"]>[] = [];
			const releasedLate: ReturnType<RunResourceLeaseController["acquire"]>[] = [];

			const steps = randInt(random, 1, 12);
			for (let step = 0; step < steps; step++) {
				const roll = random();
				if (roll < 0.5 || open.length === 0) {
					open.push(
						controller.acquire({
							promptRunId: `run-${iteration}-${step}`,
							decision: decision(randInt(random, 1, 6)),
						}),
					);
				} else if (roll < 0.8) {
					// Release a random open lease (possibly stale relative to newer acquires).
					const index = randInt(random, 0, open.length - 1);
					const lease = open.splice(index, 1)[0];
					controller.release(lease);
					releasedLate.push(lease);
				} else if (releasedLate.length > 0) {
					// Double-release an already released lease.
					controller.release(releasedLate[randInt(random, 0, releasedLate.length - 1)]);
				}
				const cap = authority.getCap();
				if (baseline !== undefined) {
					expect(cap === undefined ? Number.POSITIVE_INFINITY : cap).toBeLessThanOrEqual(baseline);
				}
			}
			for (const lease of open) {
				controller.release(lease);
			}
			expect(authority.getCap()).toBe(baseline);
			expect(controller.activeLease).toBeNull();
		}
	});
});

describe("effectiveLeaseCap", () => {
	it("floors, clamps, and applies §7.3 precedence", () => {
		expect(effectiveLeaseCap(4, 2)).toBe(2);
		expect(effectiveLeaseCap(2, 4)).toBe(2);
		expect(effectiveLeaseCap(undefined, 4)).toBe(4);
		expect(effectiveLeaseCap(0, 4)).toBe(4);
		expect(effectiveLeaseCap(4, 0)).toBe(1);
		expect(effectiveLeaseCap(2.9, 4)).toBe(2);
	});
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randInt(random: () => number, min: number, max: number): number {
	return Math.floor(random() * (max - min + 1)) + min;
}
