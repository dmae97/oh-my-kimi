import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectResourceObservationReport,
	RESOURCE_REPORT_MIN_ADMISSIONS,
} from "../src/commands/resource-doctor-cli.ts";
import type { ResourceAdmissionDecision } from "../src/core/resource-admission.ts";
import { admissionObservationFacts, ResourceObservationJournal } from "../src/core/resource-observation-journal.ts";

function decision(
	id: string,
	pressure: ResourceAdmissionDecision["pressure"],
	action: ResourceAdmissionDecision["action"],
	reasons: ResourceAdmissionDecision["reasons"] = [],
): ResourceAdmissionDecision {
	return {
		schemaVersion: 1,
		decisionId: id,
		snapshotDigest: `digest-${id}`,
		pressure,
		action,
		maxToolConcurrency: pressure === "normal" ? 4 : pressure === "constrained" ? 2 : 1,
		maxParallelLanes: pressure === "normal" ? 4 : pressure === "constrained" ? 2 : 1,
		maxHeavyProcesses: pressure === "normal" ? 2 : 1,
		reasons,
		decidedAt: "2026-08-27T00:00:00.000Z",
	};
}

function tempProject(): string {
	return mkdtempSync(join(tmpdir(), "omk-resource-report-"));
}

function recordDecision(cwd: string, promptRunId: string, value: ResourceAdmissionDecision): void {
	const journal = ResourceObservationJournal.open(cwd, promptRunId, () => new Date("2026-08-27T00:00:00.000Z"));
	expect(journal.record("resource_admission_v1", admissionObservationFacts(value))).toBe(true);
}

describe("collectResourceObservationReport", () => {
	it("aggregates bounded pressure and would-throttle evidence without identifiers", () => {
		const cwd = tempProject();
		recordDecision(cwd, "run-normal", decision("normal", "normal", "allow"));
		recordDecision(
			cwd,
			"run-constrained",
			decision("constrained", "constrained", "throttle", ["resource.memory.low", "resource.probe.partial"]),
		);
		recordDecision(
			cwd,
			"run-critical",
			decision("critical", "critical", "defer-heavy", ["resource.disk.critical", "resource.probe.timeout"]),
		);

		const report = collectResourceObservationReport(cwd);

		expect(report).toEqual({
			schemaVersion: 1,
			journalsScanned: 3,
			admissionRecords: 3,
			reasonRecords: 3,
			reasonCoverageComplete: true,
			pressure: { normal: 1, constrained: 1, critical: 1 },
			actions: { allow: 1, throttle: 1, "defer-heavy": 1 },
			wouldHaveThrottled: 2,
			probePartial: 1,
			probeTimeout: 1,
			diagnostics: 0,
			truncated: false,
			minimumSampleSize: RESOURCE_REPORT_MIN_ADMISSIONS,
			minimumSampleMet: false,
			humanReviewRequired: true,
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain(cwd);
		expect(serialized).not.toContain("run-");
		expect(serialized).not.toContain("digest-");
	});

	it("marks the 30-record floor while retaining mandatory human review", () => {
		const cwd = tempProject();
		for (let index = 0; index < RESOURCE_REPORT_MIN_ADMISSIONS; index++) {
			recordDecision(cwd, `sample-${index}`, decision(`sample-${index}`, "normal", "allow"));
		}

		expect(collectResourceObservationReport(cwd)).toMatchObject({
			admissionRecords: RESOURCE_REPORT_MIN_ADMISSIONS,
			reasonRecords: RESOURCE_REPORT_MIN_ADMISSIONS,
			reasonCoverageComplete: true,
			minimumSampleMet: true,
			humanReviewRequired: true,
		});
	});

	it("diagnoses legacy admissions without reason evidence and excludes them from the sample floor", () => {
		const cwd = tempProject();
		const journal = ResourceObservationJournal.open(cwd, "legacy", () => new Date("2026-08-27T00:00:00.000Z"));
		expect(
			journal.record("resource_admission_v1", {
				pressure: "normal",
				action: "allow",
				maxToolConcurrency: 4,
				maxParallelLanes: 4,
				maxHeavyProcesses: 2,
			}),
		).toBe(true);

		expect(collectResourceObservationReport(cwd)).toMatchObject({
			admissionRecords: 1,
			reasonRecords: 0,
			reasonCoverageComplete: false,
			diagnostics: 1,
			minimumSampleMet: false,
		});
	});

	it("diagnoses invalid reason data instead of silently treating it as empty", () => {
		const cwd = tempProject();
		const journal = ResourceObservationJournal.open(
			cwd,
			"invalid-reasons",
			() => new Date("2026-08-27T00:00:00.000Z"),
		);
		expect(journal.record("resource_admission_v1", { pressure: "normal", action: "allow", reasons: 42 })).toBe(true);

		expect(collectResourceObservationReport(cwd)).toMatchObject({
			admissionRecords: 0,
			reasonRecords: 0,
			diagnostics: 1,
		});
	});

	it("rejects symlinked run roots and reports a truncated diagnostic", () => {
		if (process.platform === "win32") return;
		const cwd = tempProject();
		const outside = tempProject();
		symlinkSync(outside, join(cwd, ".omk"), "dir");

		expect(collectResourceObservationReport(cwd)).toMatchObject({
			journalsScanned: 0,
			diagnostics: 1,
			truncated: true,
		});
	});

	it("rejects oversized journals and exposes truncation", () => {
		const cwd = tempProject();
		const runDir = join(cwd, ".omk", "runs", "oversized");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "resource-observations.jsonl"), "x".repeat(2 * 1024 * 1024 + 1), "utf8");

		expect(collectResourceObservationReport(cwd)).toMatchObject({
			journalsScanned: 0,
			diagnostics: 1,
			truncated: true,
		});
	});

	it("counts malformed journals as diagnostics and never throws", () => {
		const cwd = tempProject();
		const runDir = join(cwd, ".omk", "runs", "broken-run");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "resource-observations.jsonl"), "not-json\n", "utf8");

		expect(collectResourceObservationReport(cwd)).toMatchObject({
			journalsScanned: 1,
			admissionRecords: 0,
			diagnostics: 1,
		});
	});

	it("enforces the journal scan cap and reports truncation", () => {
		const cwd = tempProject();
		for (const id of ["a", "b", "c"]) recordDecision(cwd, id, decision(id, "normal", "allow"));

		expect(collectResourceObservationReport(cwd, { maxJournals: 2 })).toMatchObject({
			journalsScanned: 2,
			admissionRecords: 2,
			diagnostics: 0,
			truncated: true,
		});
	});
});
