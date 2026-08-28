import { captureHostResourceSnapshot, type HostResourceSnapshot } from "../core/host-resource-snapshot.ts";
import { decideResourceAdmission } from "../core/resource-admission.ts";
import {
	buildResourceDoctorReport,
	formatResourceProbeLines,
	formatResourceSummaryLines,
	type ResourceGovernorSettings,
	resolveResourceGovernorSettings,
} from "../core/resource-governor-settings.ts";
import {
	collectResourceObservationReport,
	RESOURCE_REPORT_MIN_ADMISSIONS,
	type ResourceObservationReport,
} from "../core/resource-observation-report.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export { collectResourceObservationReport, RESOURCE_REPORT_MIN_ADMISSIONS, type ResourceObservationReport };

/**
 * Headless resource diagnostic (OMK v0.97.x roadmap §19.2, M1/PR2):
 *
 *   omk doctor resources [--json] [--report]
 *
 * Observe-only: probes the host, evaluates the admission policy, and prints
 * either aligned human output or the bounded §19.2 JSON schema. This command
 * is the sanctioned local surface for raw capacity values (§11.3); it still
 * never prints usernames, hostnames, or paths (§6.2). The doctor probes even
 * when the governor mode is `off` because it only runs on explicit request.
 */

const USAGE = "Usage: omk doctor resources [--json] [--report]";

export interface ResourceDoctorCliOverrides {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly writeLine?: (line: string) => void;
	/** Test seam: replaces settings loading (defaults to SettingsManager.create(cwd)). */
	readonly loadSettings?: () => {
		readonly resourceGovernor?: ResourceGovernorSettings;
		readonly configuredMaxToolConcurrency?: number;
	};
	/** Test seam: replaces the host probe. */
	readonly capture?: typeof captureHostResourceSnapshot;
	/** Test seam: monotonic clock for probeDurationMs. */
	readonly now?: () => number;
	/** Test seam: replaces local observation aggregation. */
	readonly collectReport?: (cwd: string) => ResourceObservationReport;
}

export interface ResourceDoctorCliOutcome {
	readonly handled: boolean;
	readonly exitCode: number;
}

export async function runResourceDoctorCli(
	args: readonly string[],
	overrides: ResourceDoctorCliOverrides = {},
): Promise<ResourceDoctorCliOutcome> {
	if (args[0] !== "doctor" || args[1] !== "resources") {
		return { handled: false, exitCode: 0 };
	}
	const writeLine = overrides.writeLine ?? ((line: string) => console.log(line));

	const flags = parseDoctorFlags(args.slice(2), writeLine);
	if (flags.exit !== null) {
		return { handled: true, exitCode: flags.exit };
	}
	const json = flags.json;
	if (flags.report) {
		const report = (overrides.collectReport ?? collectResourceObservationReport)(overrides.cwd ?? process.cwd());
		if (json) writeLine(JSON.stringify(report, null, 2));
		else renderObservationReport(report, writeLine);
		return { handled: true, exitCode: 0 };
	}

	const settings = (overrides.loadSettings ?? (() => loadSettingsFromDisk(overrides.cwd)))();
	const resolved = resolveResourceGovernorSettings(settings.resourceGovernor, overrides.env ?? process.env);

	const capture = overrides.capture ?? captureHostResourceSnapshot;
	const now = overrides.now ?? (() => performance.now());
	const startedAt = now();
	const snapshot: HostResourceSnapshot = await capture({
		cwd: overrides.cwd,
		maxProbeMs: resolved.maxProbeMs,
		cpuSampleMs: resolved.cpuSampleMs,
	});
	const probeDurationMs = Math.max(0, now() - startedAt);

	const decision = decideResourceAdmission({
		snapshot,
		config: resolved.admission,
		configuredCaps: { maxToolConcurrency: settings.configuredMaxToolConcurrency },
	});

	if (json) {
		const report = buildResourceDoctorReport({ snapshot, decision, resolved, probeDurationMs });
		writeLine(JSON.stringify(report, null, 2));
		return { handled: true, exitCode: 0 };
	}
	renderHumanReport({ writeLine, resolved, decision, snapshot, probeDurationMs });
	return { handled: true, exitCode: 0 };
}

function parseDoctorFlags(
	args: readonly string[],
	writeLine: (line: string) => void,
): { readonly json: boolean; readonly report: boolean; readonly exit: number | null } {
	let json = false;
	let report = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--report") {
			report = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			writeLine(USAGE);
			return { json, report, exit: 0 };
		}
		writeLine(`Unknown argument: ${arg}`);
		writeLine(USAGE);
		return { json, report, exit: 2 };
	}
	return { json, report, exit: null };
}

function renderObservationReport(report: ResourceObservationReport, writeLine: (line: string) => void): void {
	writeLine("Resource observation report");
	writeLine(`journals scanned: ${report.journalsScanned}${report.truncated ? " (truncated)" : ""}`);
	writeLine(`admission records: ${report.admissionRecords}`);
	writeLine(`reason-qualified records: ${report.reasonRecords}`);
	writeLine(
		`pressure: normal ${report.pressure.normal}, constrained ${report.pressure.constrained}, critical ${report.pressure.critical}`,
	);
	writeLine(
		`actions: allow ${report.actions.allow}, throttle ${report.actions.throttle}, defer-heavy ${report.actions["defer-heavy"]}`,
	);
	writeLine(`would have throttled: ${report.wouldHaveThrottled}`);
	writeLine(`probe partial/timeout: ${report.probePartial}/${report.probeTimeout}`);
	writeLine(
		`minimum sample: ${report.reasonRecords}/${report.minimumSampleSize} (${report.minimumSampleMet ? "met" : "not met"})`,
	);
	writeLine(`reason coverage complete: ${report.reasonCoverageComplete ? "yes" : "no"}`);
	writeLine("human review: required");
	if (report.diagnostics > 0) writeLine(`diagnostics: ${report.diagnostics}`);
}

function renderHumanReport(input: {
	readonly writeLine: (line: string) => void;
	readonly resolved: ReturnType<typeof resolveResourceGovernorSettings>;
	readonly decision: ReturnType<typeof decideResourceAdmission>;
	readonly snapshot: HostResourceSnapshot;
	readonly probeDurationMs: number;
}): void {
	const { writeLine, resolved, decision, snapshot, probeDurationMs } = input;
	writeLine("Resource doctor");
	writeLine("");
	for (const line of formatResourceSummaryLines(resolved.mode, decision)) {
		writeLine(line);
	}
	writeLine("");
	for (const line of formatResourceProbeLines(snapshot)) {
		writeLine(line);
	}
	writeLine("");
	writeLine(`probe duration: ${Math.round(probeDurationMs)} ms`);
	for (const error of resolved.errors) {
		writeLine(`settings error: ${error}`);
	}
}

function loadSettingsFromDisk(cwd: string | undefined): {
	readonly resourceGovernor?: ResourceGovernorSettings;
	readonly configuredMaxToolConcurrency?: number;
} {
	try {
		const manager = SettingsManager.create(cwd ?? process.cwd());
		return {
			resourceGovernor: manager.getResourceGovernorSettings(),
			configuredMaxToolConcurrency: manager.getAgentRuntimeSettings().maxToolConcurrency,
		};
	} catch {
		// A broken settings file must not block the diagnostic; defaults apply.
		return {};
	}
}
