import { describe, expect, it } from "vitest";
import {
	computeHostResourceSnapshotDigest,
	HOST_RESOURCE_SNAPSHOT_VERSION,
	type HostResourceSnapshot,
} from "../src/core/host-resource-snapshot.ts";
import {
	DEFAULT_RESOURCE_ADMISSION_CAP_TABLE,
	DEFAULT_RESOURCE_ADMISSION_CONFIG,
	DEFAULT_RESOURCE_ADMISSION_THRESHOLDS,
	decideResourceAdmission,
	evaluateResourcePressure,
	RESOURCE_ADMISSION_VERSION,
	resolveResourceAdmissionConfig,
	resourcePressureRank,
	toModelResourceBudgetHint,
	validateResourceAdmissionConfig,
} from "../src/core/resource-admission.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Healthy-host fixture; overrides model degraded metrics. */
function snapshot(overrides: Partial<HostResourceSnapshot> = {}): HostResourceSnapshot {
	return {
		schemaVersion: HOST_RESOURCE_SNAPSHOT_VERSION,
		observedAt: "2026-08-21T00:00:00.000Z",
		platform: "linux",
		arch: "x64",
		logicalCpuCount: 8,
		processAvailableMemoryBytes: 8 * GIB,
		constrainedMemoryBytes: null,
		hostTotalMemoryBytes: 16 * GIB,
		hostFreeMemoryBytes: 8 * GIB,
		processRssBytes: 200 * MIB,
		heapUsedBytes: 100 * MIB,
		heapLimitBytes: 4 * GIB,
		systemCpuPercent: 20,
		workspaceAvailableBytes: 100 * GIB,
		environment: "native",
		diagnostics: [],
		...overrides,
	};
}

describe("evaluateResourcePressure", () => {
	it("scenario A (§23.3): 256 MiB available memory is critical", () => {
		const evaluation = evaluateResourcePressure(
			snapshot({ processAvailableMemoryBytes: 256 * MIB, hostFreeMemoryBytes: 256 * MIB }),
		);
		expect(evaluation.pressure).toBe("critical");
		expect(evaluation.reasons).toContain("resource.memory.critical");
	});

	it("scenario B (§23.3): 1 GiB available memory is constrained", () => {
		const evaluation = evaluateResourcePressure(
			snapshot({ processAvailableMemoryBytes: 1 * GIB, hostFreeMemoryBytes: 1 * GIB }),
		);
		expect(evaluation.pressure).toBe("constrained");
		expect(evaluation.reasons).toContain("resource.memory.low");
	});

	it("scenario C (§23.3): a healthy 8 GiB host is normal with no reasons", () => {
		const evaluation = evaluateResourcePressure(snapshot());
		expect(evaluation.pressure).toBe("normal");
		expect(evaluation.reasons).toEqual([]);
	});

	it("grades disk pressure through low and critical tiers (§6.7)", () => {
		expect(evaluateResourcePressure(snapshot({ workspaceAvailableBytes: 2 * GIB }))).toEqual({
			pressure: "constrained",
			reasons: ["resource.disk.low"],
		});
		expect(evaluateResourcePressure(snapshot({ workspaceAvailableBytes: 512 * MIB }))).toEqual({
			pressure: "critical",
			reasons: ["resource.disk.critical"],
		});
	});

	it("grades heap pressure through high and critical ratios (§6.7)", () => {
		const heap = (ratio: number) => snapshot({ heapUsedBytes: ratio * 1000 * MIB, heapLimitBytes: 1000 * MIB });
		expect(evaluateResourcePressure(heap(0.8)).pressure).toBe("constrained");
		expect(evaluateResourcePressure(heap(0.8)).reasons).toContain("resource.heap.high");
		expect(evaluateResourcePressure(heap(0.9)).pressure).toBe("critical");
		expect(evaluateResourcePressure(heap(0.9)).reasons).toContain("resource.heap.critical");
	});

	it("never reports critical from CPU alone (§6.7)", () => {
		const busy = evaluateResourcePressure(snapshot({ systemCpuPercent: 95 }));
		expect(busy.pressure).toBe("constrained");
		expect(busy.reasons).toEqual(["resource.cpu.busy"]);
		expect(evaluateResourcePressure(snapshot({ systemCpuPercent: 100 })).pressure).toBe("constrained");
	});

	it("degrades a missing key probe to constrained (§4.3)", () => {
		const noDisk = evaluateResourcePressure(snapshot({ workspaceAvailableBytes: null }));
		expect(noDisk.pressure).toBe("constrained");
		expect(noDisk.reasons).toContain("resource.probe.partial");

		const noHeap = evaluateResourcePressure(snapshot({ heapUsedBytes: 0, heapLimitBytes: 0 }));
		expect(noHeap.pressure).toBe("constrained");
		expect(noHeap.reasons).toContain("resource.probe.partial");

		const noMemory = evaluateResourcePressure(
			snapshot({ processAvailableMemoryBytes: null, constrainedMemoryBytes: null, hostFreeMemoryBytes: null }),
		);
		expect(noMemory.pressure).toBe("constrained");
		expect(noMemory.reasons).toContain("resource.probe.partial");
	});

	it("keeps a known critical fact authoritative over missing probes (§4.3)", () => {
		const evaluation = evaluateResourcePressure(
			snapshot({
				processAvailableMemoryBytes: 128 * MIB,
				hostFreeMemoryBytes: null,
				workspaceAvailableBytes: null,
			}),
		);
		expect(evaluation.pressure).toBe("critical");
		expect(evaluation.reasons).toContain("resource.memory.critical");
		expect(evaluation.reasons).toContain("resource.probe.partial");
	});

	it("never reports normal after a probe timeout (§21)", () => {
		const evaluation = evaluateResourcePressure(
			snapshot({ diagnostics: ["probe.cpu.timeout"], systemCpuPercent: null }),
		);
		expect(evaluation.pressure).toBe("constrained");
		expect(evaluation.reasons).toContain("resource.probe.timeout");
	});

	it("honors custom thresholds", () => {
		const evaluation = evaluateResourcePressure(
			snapshot({ processAvailableMemoryBytes: 4 * GIB, hostFreeMemoryBytes: 4 * GIB }),
			{
				...DEFAULT_RESOURCE_ADMISSION_THRESHOLDS,
				constrainedAvailableMemoryMiB: 8192,
			},
		);
		expect(evaluation.pressure).toBe("constrained");
		expect(evaluation.reasons).toContain("resource.memory.low");
	});
});

describe("decideResourceAdmission", () => {
	it("maps pressure tiers to §7.2 default caps and actions", () => {
		const critical = decideResourceAdmission({
			snapshot: snapshot({ processAvailableMemoryBytes: 256 * MIB, hostFreeMemoryBytes: 256 * MIB }),
		});
		expect(critical.pressure).toBe("critical");
		expect(critical.action).toBe("defer-heavy");
		expect([critical.maxToolConcurrency, critical.maxParallelLanes, critical.maxHeavyProcesses]).toEqual([1, 1, 1]);

		const constrained = decideResourceAdmission({
			snapshot: snapshot({ processAvailableMemoryBytes: 1 * GIB, hostFreeMemoryBytes: 1 * GIB }),
		});
		expect(constrained.pressure).toBe("constrained");
		expect(constrained.action).toBe("throttle");
		expect([constrained.maxToolConcurrency, constrained.maxParallelLanes, constrained.maxHeavyProcesses]).toEqual([
			2, 2, 1,
		]);

		const normal = decideResourceAdmission({ snapshot: snapshot() });
		expect(normal.pressure).toBe("normal");
		expect(normal.action).toBe("allow");
		expect([normal.maxToolConcurrency, normal.maxParallelLanes, normal.maxHeavyProcesses]).toEqual([4, 4, 2]);
	});

	it("never raises a configured cap, and limits 0-as-unlimited to the admission cap (§7.3)", () => {
		const configured = decideResourceAdmission({
			snapshot: snapshot(),
			configuredCaps: { maxToolConcurrency: 3, maxParallelLanes: 3, maxHeavyProcesses: 2 },
		});
		expect([configured.maxToolConcurrency, configured.maxParallelLanes, configured.maxHeavyProcesses]).toEqual([
			3, 3, 2,
		]);

		const unlimited = decideResourceAdmission({
			snapshot: snapshot(),
			configuredCaps: { maxToolConcurrency: 0, maxParallelLanes: 0, maxHeavyProcesses: 0 },
		});
		expect([unlimited.maxToolConcurrency, unlimited.maxParallelLanes, unlimited.maxHeavyProcesses]).toEqual([
			4, 4, 2,
		]);

		const generous = decideResourceAdmission({
			snapshot: snapshot({ processAvailableMemoryBytes: 256 * MIB, hostFreeMemoryBytes: 256 * MIB }),
			configuredCaps: { maxToolConcurrency: 8, maxParallelLanes: 8, maxHeavyProcesses: 8 },
		});
		expect([generous.maxToolConcurrency, generous.maxParallelLanes, generous.maxHeavyProcesses]).toEqual([1, 1, 1]);
	});

	it("produces a versioned, digest-linked, deterministic decision (§7.1)", () => {
		const snap = snapshot();
		const decision = decideResourceAdmission({
			snapshot: snap,
			decisionId: "res-adm-test-1",
			decidedAt: "2026-08-21T02:00:00.000Z",
		});
		expect(decision.schemaVersion).toBe(RESOURCE_ADMISSION_VERSION);
		expect(decision.decisionId).toBe("res-adm-test-1");
		expect(decision.decidedAt).toBe("2026-08-21T02:00:00.000Z");
		expect(decision.snapshotDigest).toBe(computeHostResourceSnapshotDigest(snap));
	});

	it("defaults decisionId and decidedAt to bounded generated values", () => {
		const decision = decideResourceAdmission({ snapshot: snapshot() });
		expect(decision.decisionId).toMatch(/^res-adm-[0-9a-f-]{36}$/);
		expect(Number.isNaN(Date.parse(decision.decidedAt))).toBe(false);
	});

	it("exposes only bounded fields through the model hint (§6.2)", () => {
		const decision = decideResourceAdmission({
			snapshot: snapshot({ processAvailableMemoryBytes: 1 * GIB, hostFreeMemoryBytes: 1 * GIB }),
		});
		const hint = toModelResourceBudgetHint(decision);
		expect(Object.keys(hint).sort()).toEqual(
			["maxHeavyProcesses", "maxParallelLanes", "maxToolConcurrency", "pressure", "reasons"].sort(),
		);
		expect(hint.pressure).toBe("constrained");
		expect(hint.reasons).toEqual(decision.reasons);
		expect(JSON.stringify(hint)).not.toContain("Bytes");
	});
});

describe("resolveResourceAdmissionConfig", () => {
	it("returns the §6.7/§7.2 defaults without overrides", () => {
		const resolved = resolveResourceAdmissionConfig();
		expect(resolved.errors).toEqual([]);
		expect(resolved.config).toEqual(DEFAULT_RESOURCE_ADMISSION_CONFIG);
	});

	it("merges valid overrides", () => {
		const resolved = resolveResourceAdmissionConfig({
			thresholds: { constrainedAvailableMemoryMiB: 2048 },
			caps: { normal: { maxToolConcurrency: 8 } },
		});
		expect(resolved.errors).toEqual([]);
		expect(resolved.config.thresholds.constrainedAvailableMemoryMiB).toBe(2048);
		expect(resolved.config.caps.normal.maxToolConcurrency).toBe(8);
		expect(resolved.config.caps.constrained).toEqual(DEFAULT_RESOURCE_ADMISSION_CAP_TABLE.constrained);
	});

	it("fails closed to defaults with explicit errors on invalid overrides (§18.1)", () => {
		const cases: ReadonlyArray<readonly [Parameters<typeof resolveResourceAdmissionConfig>[0], string]> = [
			[{ thresholds: { criticalAvailableMemoryMiB: 4096 } }, "criticalAvailableMemoryMiB"],
			[{ thresholds: { criticalDiskFreeMiB: 8192 } }, "criticalDiskFreeMiB"],
			[{ thresholds: { constrainedHeapRatio: 1.2 } }, "constrainedHeapRatio"],
			[{ thresholds: { criticalHeapRatio: 0.5 } }, "criticalHeapRatio"],
			[{ thresholds: { busyCpuPercent: 0 } }, "busyCpuPercent"],
			[{ thresholds: { constrainedAvailableMemoryMiB: -1 } }, "constrainedAvailableMemoryMiB"],
			[{ caps: { normal: { maxToolConcurrency: 0 } } }, "caps.normal.maxToolConcurrency"],
			[{ caps: { normal: { maxToolConcurrency: 65 } } }, "caps.normal.maxToolConcurrency"],
			[{ caps: { constrained: { maxToolConcurrency: 5 } } }, "requires normal >= constrained >= critical"],
		];
		for (const [overrides, expectedFragment] of cases) {
			const resolved = resolveResourceAdmissionConfig(overrides);
			expect(resolved.errors.length).toBeGreaterThan(0);
			expect(resolved.errors.join("\n")).toContain(expectedFragment);
			expect(resolved.config).toEqual(DEFAULT_RESOURCE_ADMISSION_CONFIG);
		}
	});

	it("accepts the default config as valid", () => {
		expect(validateResourceAdmissionConfig(DEFAULT_RESOURCE_ADMISSION_CONFIG)).toEqual([]);
	});
});

describe("admission properties (§23.2, fixed seed 0x0fc52026)", () => {
	const SEED = 0x0fc52026;
	const ITERATIONS = 200;

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

	it("property 1: less available memory never increases concurrency", () => {
		const random = mulberry32(SEED);
		for (let i = 0; i < ITERATIONS; i++) {
			const memoryHigh = randInt(random, 1 * MIB, 16 * GIB);
			const memoryLow = randInt(random, 1 * MIB, memoryHigh);
			const configuredCaps = {
				maxToolConcurrency: randInt(random, 0, 8),
				maxParallelLanes: randInt(random, 0, 8),
				maxHeavyProcesses: randInt(random, 0, 8),
			};
			const better = decideResourceAdmission({
				snapshot: snapshot({ processAvailableMemoryBytes: memoryHigh, hostFreeMemoryBytes: memoryHigh }),
				configuredCaps,
			});
			const worse = decideResourceAdmission({
				snapshot: snapshot({ processAvailableMemoryBytes: memoryLow, hostFreeMemoryBytes: memoryLow }),
				configuredCaps,
			});
			expect(resourcePressureRank(worse.pressure)).toBeGreaterThanOrEqual(resourcePressureRank(better.pressure));
			expect(worse.maxToolConcurrency).toBeLessThanOrEqual(better.maxToolConcurrency);
			expect(worse.maxParallelLanes).toBeLessThanOrEqual(better.maxParallelLanes);
			expect(worse.maxHeavyProcesses).toBeLessThanOrEqual(better.maxHeavyProcesses);
		}
	});

	it("property 2: less free disk never improves pressure", () => {
		const random = mulberry32(SEED);
		for (let i = 0; i < ITERATIONS; i++) {
			const diskHigh = randInt(random, 1 * MIB, 200 * GIB);
			const diskLow = randInt(random, 1 * MIB, diskHigh);
			const better = evaluateResourcePressure(snapshot({ workspaceAvailableBytes: diskHigh }));
			const worse = evaluateResourcePressure(snapshot({ workspaceAvailableBytes: diskLow }));
			expect(resourcePressureRank(worse.pressure)).toBeGreaterThanOrEqual(resourcePressureRank(better.pressure));
		}
	});

	it("property 3: higher CPU never improves pressure and never reaches critical alone", () => {
		const random = mulberry32(SEED);
		for (let i = 0; i < ITERATIONS; i++) {
			const cpuLow = randInt(random, 0, 100);
			const cpuHigh = randInt(random, cpuLow, 100);
			const better = evaluateResourcePressure(snapshot({ systemCpuPercent: cpuLow }));
			const worse = evaluateResourcePressure(snapshot({ systemCpuPercent: cpuHigh }));
			expect(resourcePressureRank(worse.pressure)).toBeGreaterThanOrEqual(resourcePressureRank(better.pressure));
			expect(worse.pressure).not.toBe("critical");
		}
	});

	it("property 4: caps stay monotonic critical <= constrained <= normal across random valid configs", () => {
		const random = mulberry32(SEED);
		const capFields = ["maxToolConcurrency", "maxParallelLanes", "maxHeavyProcesses"] as const;
		for (let i = 0; i < ITERATIONS; i++) {
			const tiers = { normal: {}, constrained: {}, critical: {} } as Record<
				"normal" | "constrained" | "critical",
				Record<(typeof capFields)[number], number>
			>;
			for (const field of capFields) {
				const values = [randInt(random, 1, 64), randInt(random, 1, 64), randInt(random, 1, 64)].sort(
					(a, b) => b - a,
				);
				tiers.normal[field] = values[0];
				tiers.constrained[field] = values[1];
				tiers.critical[field] = values[2];
			}
			const resolved = resolveResourceAdmissionConfig({ caps: tiers });
			expect(resolved.errors).toEqual([]);
			const decisions = [
				decideResourceAdmission({ snapshot: snapshot(), config: resolved.config }),
				decideResourceAdmission({
					snapshot: snapshot({ processAvailableMemoryBytes: 1 * GIB, hostFreeMemoryBytes: 1 * GIB }),
					config: resolved.config,
				}),
				decideResourceAdmission({
					snapshot: snapshot({ processAvailableMemoryBytes: 128 * MIB, hostFreeMemoryBytes: 128 * MIB }),
					config: resolved.config,
				}),
			];
			expect(decisions.map((decision) => decision.pressure)).toEqual(["normal", "constrained", "critical"]);
			for (const field of capFields) {
				expect(decisions[1][field]).toBeLessThanOrEqual(decisions[0][field]);
				expect(decisions[2][field]).toBeLessThanOrEqual(decisions[1][field]);
			}
		}
	});

	it("property 5: admission never exceeds a positive configured cap", () => {
		const random = mulberry32(SEED);
		const memories = [8 * GIB, 1 * GIB, 128 * MIB];
		for (let i = 0; i < ITERATIONS; i++) {
			const memory = memories[randInt(random, 0, memories.length - 1)];
			const configuredCaps = {
				maxToolConcurrency: randInt(random, 0, 100),
				maxParallelLanes: randInt(random, 0, 100),
				maxHeavyProcesses: randInt(random, 0, 100),
			};
			const decision = decideResourceAdmission({
				snapshot: snapshot({ processAvailableMemoryBytes: memory, hostFreeMemoryBytes: memory }),
				configuredCaps,
			});
			const tier = DEFAULT_RESOURCE_ADMISSION_CAP_TABLE[decision.pressure];
			for (const field of ["maxToolConcurrency", "maxParallelLanes", "maxHeavyProcesses"] as const) {
				expect(decision[field]).toBeGreaterThanOrEqual(1);
				expect(decision[field]).toBeLessThanOrEqual(tier[field]);
				const configured = configuredCaps[field];
				if (configured > 0) {
					expect(decision[field]).toBeLessThanOrEqual(configured);
				}
			}
		}
	});
});
