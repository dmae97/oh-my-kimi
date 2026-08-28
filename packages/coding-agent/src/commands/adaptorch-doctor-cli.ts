import {
	type AdaptOrchApiClient,
	AdaptOrchApiError,
	type AdaptOrchFetch,
	createAdaptOrchApiClientFromEnv,
} from "omk-adaptorch-wpl";

/**
 * Headless AdaptOrch connectivity check:
 *
 *   omk doctor adaptorch [--json]
 *
 * One command answers the only question that blocks getting started: does the
 * configured key reach the hosted API? It calls `GET /v1/whoami`, which is the
 * cheapest authenticated read in the contract, and reports the principal it
 * resolved to.
 *
 * The exit code carries the verdict so a script can branch without parsing
 * prose: 0 verified, 1 not configured, 2 configured but unreachable. Those are
 * genuinely different states — "no key" is a setup step, while "key rejected"
 * is a broken setup, and collapsing them would make the command useless in CI.
 *
 * The credential is never printed. `omk-adaptorch-wpl` already scrubs it from
 * its own errors; this command additionally never echoes the configured value.
 */

const USAGE = "Usage: omk doctor adaptorch [--json]";

export interface AdaptOrchDoctorCliOverrides {
	readonly env?: NodeJS.ProcessEnv;
	readonly writeLine?: (line: string) => void;
	/** Test seam: replaces the injected HTTP boundary (defaults to global fetch). */
	readonly fetch?: AdaptOrchFetch;
}

export interface AdaptOrchDoctorCliOutcome {
	readonly handled: boolean;
	readonly exitCode: number;
}

/** Bounded report shape. Carries no credential, URL credentials, or raw error bodies. */
interface AdaptOrchDoctorReport {
	readonly configured: boolean;
	readonly reachable: boolean;
	readonly subjectId?: string;
	readonly projectId?: string;
	readonly status?: number;
	readonly code?: string;
	readonly error?: string;
}

function describe(report: AdaptOrchDoctorReport): string[] {
	if (!report.configured) {
		return [
			"AdaptOrch: not configured",
			"  Set ADAPTORCH_API_KEY to enable it. Optionally set ADAPTORCH_API_URL.",
			"  AdaptOrch is a separate product; OMK does not require it.",
		];
	}
	if (!report.reachable) {
		const detail =
			report.status === undefined ? "" : ` (HTTP ${report.status}${report.code ? ` ${report.code}` : ""})`;
		return [`AdaptOrch: unreachable${detail}`, `  ${report.error ?? "the request did not complete"}`];
	}
	const scope = report.projectId ? `, project ${report.projectId}` : "";
	return [`AdaptOrch: verified`, `  Authenticated as ${report.subjectId ?? "(unknown subject)"}${scope}`];
}

async function probe(client: AdaptOrchApiClient): Promise<AdaptOrchDoctorReport> {
	try {
		const principal = await client.whoami();
		return {
			configured: true,
			reachable: true,
			subjectId: principal.subject_id,
			...(principal.project_id === undefined ? {} : { projectId: principal.project_id }),
		};
	} catch (error) {
		if (error instanceof AdaptOrchApiError) {
			return {
				configured: true,
				reachable: false,
				status: error.status,
				...(error.code === undefined ? {} : { code: error.code }),
				error: error.message,
			};
		}
		return {
			configured: true,
			reachable: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runAdaptOrchDoctorCli(
	args: readonly string[],
	overrides: AdaptOrchDoctorCliOverrides = {},
): Promise<AdaptOrchDoctorCliOutcome> {
	if (args[0] !== "doctor" || args[1] !== "adaptorch") {
		return { handled: false, exitCode: 0 };
	}
	const writeLine = overrides.writeLine ?? ((line: string) => console.log(line));

	let json = false;
	for (const arg of args.slice(2)) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			writeLine(USAGE);
			return { handled: true, exitCode: 0 };
		}
		writeLine(`Unknown option: ${arg}`);
		writeLine(USAGE);
		return { handled: true, exitCode: 2 };
	}

	const env = overrides.env ?? process.env;
	const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as AdaptOrchFetch);

	let report: AdaptOrchDoctorReport;
	try {
		const client = createAdaptOrchApiClientFromEnv(fetchImpl, env);
		report = client ? await probe(client) : { configured: false, reachable: false };
	} catch (error) {
		// A configured but invalid setup (an unsafe ADAPTORCH_API_URL, for
		// example) is a broken setup, not an absent one.
		report = {
			configured: true,
			reachable: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	if (json) writeLine(JSON.stringify(report, null, 2));
	else for (const line of describe(report)) writeLine(line);

	if (!report.configured) return { handled: true, exitCode: 1 };
	return { handled: true, exitCode: report.reachable ? 0 : 2 };
}
