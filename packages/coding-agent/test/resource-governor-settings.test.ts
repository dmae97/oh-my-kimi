import { describe, expect, it } from "vitest";
import { HOST_RESOURCE_SNAPSHOT_VERSION, type HostResourceSnapshot } from "../src/core/host-resource-snapshot.ts";
import { DEFAULT_RESOURCE_ADMISSION_CONFIG, decideResourceAdmission } from "../src/core/resource-admission.ts";
import {
	buildResourceDoctorReport,
	DEFAULT_RESOURCE_GOVERNOR_MODE,
	describeResourceReasons,
	formatResourcePolicyLines,
	formatResourceProbeLines,
	formatResourceSummaryLines,
	RESOURCE_GOVERNOR_MODE_ENV,
	resolveResourceGovernorSettings,
} from "../src/core/resource-governor-settings.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

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

describe("resolveResourceGovernorSettings", () => {
	it("defaults to observe mode with the default admission config (§7.4 alpha rollout)", () => {
		const resolved = resolveResourceGovernorSettings(undefined, {});
		expect(resolved.mode).toBe(DEFAULT_RESOURCE_GOVERNOR_MODE);
		expect(resolved.mode).toBe("observe");
		expect(resolved.admission).toEqual(DEFAULT_RESOURCE_ADMISSION_CONFIG);
		expect(resolved.errors).toEqual([]);
		expect(resolved.maxProbeMs).toBeUndefined();
		expect(resolved.cpuSampleMs).toBeUndefined();
	});

	it("lets the OMK_RESOURCE_GOVERNOR env override win over settings (§18.2, §30.1)", () => {
		const resolved = resolveResourceGovernorSettings({ mode: "adaptive" }, { [RESOURCE_GOVERNOR_MODE_ENV]: "off" });
		expect(resolved.mode).toBe("off");
		expect(resolved.errors).toEqual([]);
	});

	it("reports an invalid env mode and falls back to settings", () => {
		const resolved = resolveResourceGovernorSettings({ mode: "strict" }, { [RESOURCE_GOVERNOR_MODE_ENV]: "turbo" });
		expect(resolved.mode).toBe("strict");
		expect(resolved.errors.join("\n")).toContain(RESOURCE_GOVERNOR_MODE_ENV);
	});

	it("maps enabled:false to off and rejects unknown configured modes", () => {
		expect(resolveResourceGovernorSettings({ enabled: false, mode: "adaptive" }, {}).mode).toBe("off");
		const invalid = resolveResourceGovernorSettings({ mode: "warp" as never }, {});
		expect(invalid.mode).toBe("observe");
		expect(invalid.errors.join("\n")).toContain("resourceGovernor.mode");
	});

	it("validates probe timing ranges with explicit errors instead of silent clamps (§18.1)", () => {
		const valid = resolveResourceGovernorSettings({ maxProbeMs: 500, cpuSampleMs: 200 }, {});
		expect(valid.maxProbeMs).toBe(500);
		expect(valid.cpuSampleMs).toBe(200);
		expect(valid.errors).toEqual([]);

		const invalid = resolveResourceGovernorSettings({ maxProbeMs: 10, cpuSampleMs: 999 }, {});
		expect(invalid.maxProbeMs).toBeUndefined();
		expect(invalid.cpuSampleMs).toBeUndefined();
		expect(invalid.errors.join("\n")).toContain("resourceGovernor.maxProbeMs");
		expect(invalid.errors.join("\n")).toContain("resourceGovernor.cpuSampleMs");
	});

	it("maps threshold and cap settings into the admission config", () => {
		const resolved = resolveResourceGovernorSettings(
			{
				constrainedAvailableMemoryMiB: 2048,
				criticalDiskFreeMiB: 512,
				normalMaxToolConcurrency: 8,
				constrainedMaxParallelLanes: 1,
				criticalMaxHeavyProcesses: 1,
			},
			{},
		);
		expect(resolved.errors).toEqual([]);
		expect(resolved.admission.thresholds.constrainedAvailableMemoryMiB).toBe(2048);
		expect(resolved.admission.thresholds.criticalDiskFreeMiB).toBe(512);
		expect(resolved.admission.caps.normal.maxToolConcurrency).toBe(8);
		expect(resolved.admission.caps.constrained.maxParallelLanes).toBe(1);
		expect(resolved.admission.caps.critical.maxHeavyProcesses).toBe(1);
	});

	it("fails closed to the default admission config on invalid thresholds (§18.1)", () => {
		const resolved = resolveResourceGovernorSettings({ criticalAvailableMemoryMiB: 4096 }, {});
		expect(resolved.errors.length).toBeGreaterThan(0);
		expect(resolved.admission).toEqual(DEFAULT_RESOURCE_ADMISSION_CONFIG);
	});
});

describe("resource formatters", () => {
	it("humanizes reason codes for the §19.1 summary", () => {
		expect(describeResourceReasons([])).toBe("none");
		expect(describeResourceReasons(["resource.memory.low", "resource.cpu.busy"])).toBe("memory low, CPU busy");
	});

	it("renders the §19.1 summary block", () => {
		const decision = decideResourceAdmission({
			snapshot: snapshot({
				processAvailableMemoryBytes: 1 * GIB,
				hostFreeMemoryBytes: 1 * GIB,
				systemCpuPercent: 95,
			}),
		});
		const lines = formatResourceSummaryLines("observe", decision);
		expect(lines).toEqual([
			"mode: observe",
			"pressure: constrained",
			"action: throttle",
			"tool concurrency: 2",
			"subagent lanes: 2",
			"heavy processes: 1",
			"reasons: memory low, CPU busy",
		]);
	});

	it("renders verbose probe lines with MiB units and diagnostics", () => {
		const lines = formatResourceProbeLines(
			snapshot({ diagnostics: ["probe.cpu.unavailable"], systemCpuPercent: null }),
		);
		const text = lines.join("\n");
		expect(text).toContain("environment: native (linux/x64, 8 CPUs)");
		expect(text).toContain("effective available memory: 8,192 MiB");
		expect(text).toContain("workspace disk available: 102,400 MiB");
		expect(text).toContain("system CPU: unknown");
		expect(text).toContain("diagnostics: probe.cpu.unavailable");
	});

	it("renders policy lines including §18.1 validation errors", () => {
		const resolved = resolveResourceGovernorSettings({ busyCpuPercent: 300 }, {});
		const text = formatResourcePolicyLines(resolved).join("\n");
		expect(text).toContain("mode: observe");
		expect(text).toContain("memory MiB (constrained/critical): 1536/512");
		expect(text).toContain("caps normal: tools 4, lanes 4, heavy 2");
		expect(text).toContain("error: resourceGovernor.busyCpuPercent");
	});
});

describe("buildResourceDoctorReport", () => {
	it("emits the bounded §19.2 schema without host identity fields", () => {
		const snap = snapshot();
		const resolved = resolveResourceGovernorSettings(undefined, {});
		const decision = decideResourceAdmission({ snapshot: snap, config: resolved.admission });
		const report = buildResourceDoctorReport({ snapshot: snap, decision, resolved, probeDurationMs: 182.6 });

		expect(report.schemaVersion).toBe(1);
		expect(report.command).toBe("resource_doctor");
		expect(report.mode).toBe("observe");
		expect(report.pressure).toBe("normal");
		expect(report.action).toBe("allow");
		expect(report.caps).toEqual({ maxToolConcurrency: 4, maxParallelLanes: 4, maxHeavyProcesses: 2 });
		expect(report.probeDurationMs).toBe(183);
		expect(report.snapshot.effectiveAvailableMemoryMiB).toBe(8192);
		expect(report.snapshot.workspaceAvailableMiB).toBe(102_400);
		expect(report.snapshot.heapUsedRatio).toBeCloseTo(0.0244, 3);
		expect(report.settingsErrors).toEqual([]);

		const keys = Object.keys(report.snapshot).sort();
		expect(keys).toEqual(
			[
				"environment",
				"logicalCpuCount",
				"effectiveAvailableMemoryMiB",
				"processAvailableMemoryMiB",
				"constrainedMemoryMiB",
				"hostFreeMemoryMiB",
				"hostTotalMemoryMiB",
				"workspaceAvailableMiB",
				"heapUsedRatio",
				"systemCpuPercent",
				"diagnostics",
			].sort(),
		);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("hostname");
		expect(serialized).not.toContain("username");
		expect(serialized).not.toContain("/home/");
	});
});
