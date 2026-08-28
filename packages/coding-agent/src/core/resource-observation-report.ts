import { RESOURCE_REASON_CODES, type ResourceReasonCode } from "./resource-admission.ts";
import { parseResourceObservationLine, type ResourceObservationRecord } from "./resource-observation-journal.ts";
import { collectResourceJournalTexts } from "./resource-observation-report-reader.ts";

export const RESOURCE_REPORT_MIN_ADMISSIONS = 30;
const DEFAULT_MAX_JOURNALS = 500;
const MAX_RECORDS_PER_JOURNAL = 10_000;
const REASON_CODES: ReadonlySet<string> = new Set(RESOURCE_REASON_CODES);

export interface ResourceObservationReport {
	readonly schemaVersion: 1;
	readonly journalsScanned: number;
	readonly admissionRecords: number;
	readonly reasonRecords: number;
	readonly reasonCoverageComplete: boolean;
	readonly pressure: Readonly<Record<"normal" | "constrained" | "critical", number>>;
	readonly actions: Readonly<Record<"allow" | "throttle" | "defer-heavy", number>>;
	readonly wouldHaveThrottled: number;
	readonly probePartial: number;
	readonly probeTimeout: number;
	readonly diagnostics: number;
	readonly truncated: boolean;
	readonly minimumSampleSize: number;
	readonly minimumSampleMet: boolean;
	readonly humanReviewRequired: true;
}

export interface ResourceObservationReportOptions {
	readonly maxJournals?: number;
}

/** Aggregate bounded, identifier-free admission evidence from local run journals. */
export function collectResourceObservationReport(
	cwd: string,
	options: ResourceObservationReportOptions = {},
): ResourceObservationReport {
	const maxJournals = boundedMaxJournals(options.maxJournals);
	const collection = collectResourceJournalTexts(cwd, maxJournals);
	const pressure = { normal: 0, constrained: 0, critical: 0 };
	const actions = { allow: 0, throttle: 0, "defer-heavy": 0 };
	let admissionRecords = 0;
	let reasonRecords = 0;
	let wouldHaveThrottled = 0;
	let probePartial = 0;
	let probeTimeout = 0;
	let diagnostics = collection.diagnostics;
	let truncated = collection.truncated;

	for (const raw of collection.journals) {
		let recordsSeen = 0;
		for (const rawLine of raw.split("\n")) {
			const line = rawLine.trim();
			if (line === "") continue;
			if (recordsSeen >= MAX_RECORDS_PER_JOURNAL) {
				diagnostics += 1;
				truncated = true;
				break;
			}
			recordsSeen += 1;
			const record = parseResourceObservationLine(line);
			if (record === null) {
				diagnostics += 1;
				continue;
			}
			if (record.kind !== "resource_admission_v1") continue;
			const admission = parseAdmissionFacts(record);
			if (admission === null) {
				diagnostics += 1;
				continue;
			}
			admissionRecords += 1;
			pressure[admission.pressure] += 1;
			actions[admission.action] += 1;
			if (admission.action !== "allow") wouldHaveThrottled += 1;
			if (!admission.hasReasonEvidence) {
				diagnostics += 1;
				continue;
			}
			reasonRecords += 1;
			if (admission.reasons.includes("resource.probe.partial")) probePartial += 1;
			if (admission.reasons.includes("resource.probe.timeout")) probeTimeout += 1;
		}
	}

	return {
		schemaVersion: 1,
		journalsScanned: collection.journals.length,
		admissionRecords,
		reasonRecords,
		reasonCoverageComplete: admissionRecords > 0 && reasonRecords === admissionRecords,
		pressure,
		actions,
		wouldHaveThrottled,
		probePartial,
		probeTimeout,
		diagnostics,
		truncated,
		minimumSampleSize: RESOURCE_REPORT_MIN_ADMISSIONS,
		minimumSampleMet: reasonRecords >= RESOURCE_REPORT_MIN_ADMISSIONS,
		humanReviewRequired: true,
	};
}

function boundedMaxJournals(value: number | undefined): number {
	if (value === undefined || !Number.isSafeInteger(value)) return DEFAULT_MAX_JOURNALS;
	return Math.max(1, Math.min(DEFAULT_MAX_JOURNALS, value));
}

function parseAdmissionFacts(record: ResourceObservationRecord): {
	readonly pressure: "normal" | "constrained" | "critical";
	readonly action: "allow" | "throttle" | "defer-heavy";
	readonly reasons: readonly ResourceReasonCode[];
	readonly hasReasonEvidence: boolean;
} | null {
	const pressure = record.facts.pressure;
	const action = record.facts.action;
	if (pressure !== "normal" && pressure !== "constrained" && pressure !== "critical") return null;
	if (action !== "allow" && action !== "throttle" && action !== "defer-heavy") return null;
	const rawReasons = record.facts.reasons;
	if (rawReasons === undefined) return { pressure, action, reasons: [], hasReasonEvidence: false };
	if (typeof rawReasons !== "string") return null;
	const reasons = rawReasons === "" ? [] : rawReasons.split(",");
	if (reasons.some((reason) => !REASON_CODES.has(reason))) return null;
	return { pressure, action, reasons: reasons as ResourceReasonCode[], hasReasonEvidence: true };
}
