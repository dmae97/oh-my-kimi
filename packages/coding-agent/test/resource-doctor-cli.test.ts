import { describe, expect, it } from "vitest";
import { runResourceDoctorCli } from "../src/commands/resource-doctor-cli.ts";
import {
	HOST_RESOURCE_SNAPSHOT_VERSION,
	type HostResourceProbeOptions,
	type HostResourceSnapshot,
} from "../src/core/host-resource-snapshot.ts";
import type { ResourceDoctorReport } from "../src/core/resource-governor-settings.ts";

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

function collectLines(): { lines: string[]; writeLine: (line: string) => void } {
	const lines: string[] = [];
	return { lines, writeLine: (line) => lines.push(line) };
}

function parseReport(lines: readonly string[]): ResourceDoctorReport {
	const text = lines.join("\n");
	try {
		return JSON.parse(text) as ResourceDoctorReport;
	} catch (error) {
		throw new Error(`doctor --json output was not valid JSON: ${text.slice(0, 200)} (${String(error)})`);
	}
}

describe("runResourceDoctorCli", () => {
	it("ignores unrelated argv", async () => {
		expect(await runResourceDoctorCli([])).toEqual({ handled: false, exitCode: 0 });
		expect(await runResourceDoctorCli(["doctor"])).toEqual({ handled: false, exitCode: 0 });
		expect(await runResourceDoctorCli(["session", "doctor"])).toEqual({ handled: false, exitCode: 0 });
		expect(await runResourceDoctorCli(["stats"])).toEqual({ handled: false, exitCode: 0 });
	});

	it("prints usage and exits 2 on unknown flags", async () => {
		const { lines, writeLine } = collectLines();
		const outcome = await runResourceDoctorCli(["doctor", "resources", "--verbose"], { writeLine });
		expect(outcome).toEqual({ handled: true, exitCode: 2 });
		expect(lines.join("\n")).toContain("Unknown argument: --verbose");
		expect(lines.join("\n")).toContain("Usage: omk doctor resources [--json]");
	});

	it("prints usage for --help", async () => {
		const { lines, writeLine } = collectLines();
		const outcome = await runResourceDoctorCli(["doctor", "resources", "--help"], { writeLine });
		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		expect(lines).toEqual(["Usage: omk doctor resources [--json]"]);
	});

	it("renders the human report with summary and verbose probe sections", async () => {
		const { lines, writeLine } = collectLines();
		const outcome = await runResourceDoctorCli(["doctor", "resources"], {
			writeLine,
			env: {},
			loadSettings: () => ({ resourceGovernor: {}, configuredMaxToolConcurrency: 3 }),
			capture: async () => snapshot({ processAvailableMemoryBytes: 1 * GIB, hostFreeMemoryBytes: 1 * GIB }),
			now: (() => {
				let calls = 0;
				return () => {
					calls += 1;
					return calls === 1 ? 1000 : 1182;
				};
			})(),
		});
		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		const text = lines.join("\n");
		expect(text).toContain("Resource doctor");
		expect(text).toContain("mode: observe");
		expect(text).toContain("pressure: constrained");
		expect(text).toContain("action: throttle");
		expect(text).toContain("tool concurrency: 2");
		expect(text).toContain("reasons: memory low");
		expect(text).toContain("effective available memory: 1,024 MiB");
		expect(text).toContain("probe duration: 182 ms");
	});

	it("honors configured caps in the human report (§7.3)", async () => {
		const { lines, writeLine } = collectLines();
		await runResourceDoctorCli(["doctor", "resources"], {
			writeLine,
			env: {},
			loadSettings: () => ({ resourceGovernor: {}, configuredMaxToolConcurrency: 2 }),
			capture: async () => snapshot(),
		});
		expect(lines.join("\n")).toContain("tool concurrency: 2");
	});

	it("emits the bounded §19.2 JSON schema with --json", async () => {
		const { lines, writeLine } = collectLines();
		const probeOptions: HostResourceProbeOptions[] = [];
		const outcome = await runResourceDoctorCli(["doctor", "resources", "--json"], {
			writeLine,
			env: { OMK_RESOURCE_GOVERNOR: "strict" },
			loadSettings: () => ({ resourceGovernor: { maxProbeMs: 120, cpuSampleMs: 150 } }),
			capture: async (options) => {
				probeOptions.push(options ?? {});
				return snapshot({ workspaceAvailableBytes: 512 * MIB });
			},
		});
		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		expect(probeOptions[0]?.maxProbeMs).toBe(120);
		expect(probeOptions[0]?.cpuSampleMs).toBe(150);

		const report = parseReport(lines);
		expect(report.schemaVersion).toBe(1);
		expect(report.command).toBe("resource_doctor");
		expect(report.mode).toBe("strict");
		expect(report.pressure).toBe("critical");
		expect(report.action).toBe("defer-heavy");
		expect(report.reasons).toContain("resource.disk.critical");
		expect(report.caps).toEqual({ maxToolConcurrency: 1, maxParallelLanes: 1, maxHeavyProcesses: 1 });
		expect(report.snapshot.workspaceAvailableMiB).toBe(512);
		expect(report.settingsErrors).toEqual([]);
	});

	it("surfaces settings validation errors without failing the diagnostic (§18.1)", async () => {
		const { lines, writeLine } = collectLines();
		const outcome = await runResourceDoctorCli(["doctor", "resources", "--json"], {
			writeLine,
			env: {},
			loadSettings: () => ({ resourceGovernor: { criticalAvailableMemoryMiB: 4096 } }),
			capture: async () => snapshot(),
		});
		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		const report = parseReport(lines);
		expect(report.settingsErrors.length).toBeGreaterThan(0);
		expect(report.pressure).toBe("normal");
	});

	it("runs against the real host and settings (integration smoke)", async () => {
		const { lines, writeLine } = collectLines();
		const outcome = await runResourceDoctorCli(["doctor", "resources", "--json"], { writeLine, env: {} });
		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		const report = parseReport(lines);
		expect(report.schemaVersion).toBe(1);
		expect(["normal", "constrained", "critical"]).toContain(report.pressure);
		expect(report.probeDurationMs).toBeLessThan(5000);
	});
});
