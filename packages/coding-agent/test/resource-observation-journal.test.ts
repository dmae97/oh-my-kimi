import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceAdmissionDecision } from "../src/core/resource-admission.ts";
import {
	admissionObservationFacts,
	classificationObservationFacts,
	RESOURCE_OBSERVATION_KINDS,
	ResourceObservationJournal,
	type ResourceObservationRecord,
	settledObservationFacts,
	snapshotObservationFacts,
	soundObservationFacts,
	toProtocolObservation,
} from "../src/core/resource-observation-journal.ts";
import { classifyWorkloadCommand } from "../src/core/workload-classifier.ts";

const NOW = () => new Date("2026-08-21T00:00:00.000Z");

const DECISION: ResourceAdmissionDecision = {
	schemaVersion: 1,
	decisionId: "adm-1",
	snapshotDigest: "digest-1",
	pressure: "constrained",
	action: "throttle",
	maxToolConcurrency: 2,
	maxParallelLanes: 2,
	maxHeavyProcesses: 1,
	reasons: ["resource.memory.low"],
	decidedAt: "2026-08-21T00:00:00.000Z",
};

function openJournal(): { journal: ResourceObservationJournal; cwd: string } {
	const cwd = mkdtempSync(join(tmpdir(), "omk-resource-obs-"));
	return { journal: ResourceObservationJournal.open(cwd, "prompt-run-obs", NOW), cwd };
}

describe("observation fact builders (§15.2 privacy)", () => {
	it("admission facts carry the §15.2 example shape", () => {
		expect(admissionObservationFacts(DECISION)).toEqual({
			decisionId: "adm-1",
			snapshotDigest: "digest-1",
			pressure: "constrained",
			action: "throttle",
			maxToolConcurrency: 2,
			maxParallelLanes: 2,
			maxHeavyProcesses: 1,
			reasons: "resource.memory.low",
		});
	});

	it("snapshot facts expose probe health only — never raw host values", () => {
		const facts = snapshotObservationFacts({
			systemCpuPercent: 42.5,
			processAvailableMemoryBytes: 8_000_000_000,
			hostFreeMemoryBytes: 16_000_000_000,
			heapLimitBytes: 4_000_000_000,
		});
		expect(facts).toEqual({ cpuProbe: true, memoryProbe: true, heapLimitKnown: true });
		for (const value of Object.values(facts)) {
			expect(typeof value).toBe("boolean");
		}
	});

	it("classification, settlement, and sound facts stay flat and bounded", () => {
		const classification = classificationObservationFacts(classifyWorkloadCommand("vitest run"));
		expect(classification.commandFamily).toBe("node-test");
		expect(typeof classification.reasonCodes).toBe("string");
		expect(
			settledObservationFacts({ type: "prompt_settled", promptRunId: "p", outcome: "completed", durationMs: 12 }),
		).toEqual({ outcome: "completed", durationMs: 12 });
		const sound = soundObservationFacts({
			backend: "macos-afplay",
			attempted: true,
			success: false,
			diagnostic: "x".repeat(500),
		});
		expect((sound.diagnostic as string).length).toBe(120);
	});
});

describe("ResourceObservationJournal", () => {
	it("appends and reloads records with monotonic seq", () => {
		const { journal } = openJournal();
		expect(journal.record("resource_admission_v1", admissionObservationFacts(DECISION))).toBe(true);
		expect(journal.record("prompt_settled_v1", { outcome: "completed", durationMs: 5 })).toBe(true);
		const loaded = journal.load();
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.records.map((record) => [record.seq, record.kind])).toEqual([
			[1, "resource_admission_v1"],
			[2, "prompt_settled_v1"],
		]);
		expect(loaded.records[0]?.promptRunId).toBe("prompt-run-obs");
	});

	it("fails open: malformed and unknown-kind lines become diagnostics, never throws", () => {
		const { journal } = openJournal();
		journal.record("resource_admission_v1", admissionObservationFacts(DECISION));
		writeFileSync(
			journal.filePath,
			`${readFileSync(journal.filePath, "utf8")}not-json\n{"schemaVersion":1,"seq":2,"kind":"evil_v1","at":"x","promptRunId":"p","facts":{}}\n`,
		);
		const loaded = journal.load();
		expect(loaded.records).toHaveLength(1);
		expect(loaded.diagnostics).toHaveLength(2);
	});

	it("fails open on unwritable paths instead of breaking the run", () => {
		// A path under a regular FILE fails mkdir with ENOTDIR immediately.
		const cwd = mkdtempSync(join(tmpdir(), "omk-resource-obs-bad-"));
		const blocker = join(cwd, "blocker");
		writeFileSync(blocker, "file");
		const journal = new ResourceObservationJournal(join(blocker, "sub", "resource.jsonl"), "p", NOW);
		expect(journal.record("prompt_settled_v1", { outcome: "completed", durationMs: 1 })).toBe(false);
		expect(journal.load().records).toEqual([]);
	});

	it("rejects nested facts on load (flat primitives only)", () => {
		const { journal } = openJournal();
		// One valid record creates the run directory; then replace the file body.
		journal.record("prompt_settled_v1", { outcome: "completed", durationMs: 1 });
		writeFileSync(
			journal.filePath,
			`${JSON.stringify({ schemaVersion: 1, seq: 1, kind: "prompt_settled_v1", at: "t", promptRunId: "p", facts: { nested: { deep: 1 } } })}\n`,
		);
		const loaded = journal.load();
		expect(loaded.records).toEqual([]);
		expect(loaded.diagnostics).toHaveLength(1);
	});
});

describe("toProtocolObservation (§15.1)", () => {
	it("maps journal kinds onto protocol observation kinds", () => {
		const record = (kind: ResourceObservationRecord["kind"]): ResourceObservationRecord => ({
			schemaVersion: 1,
			seq: 1,
			kind,
			at: "t",
			promptRunId: "p",
			facts: {},
		});
		expect(toProtocolObservation(record("resource_admission_v1"))?.kind).toBe("resource_admission.v1");
		expect(toProtocolObservation(record("resource_snapshot_v1"))?.kind).toBe("resource_snapshot.v1");
		for (const permitKind of [
			"workload_permit_wait_v1",
			"workload_permit_acquired_v1",
			"workload_permit_released_v1",
		] as const) {
			expect(toProtocolObservation(record(permitKind))?.kind).toBe("workload_permit.v1");
		}
		expect(toProtocolObservation(record("completion_sound_result_v1"))?.kind).toBe("notification_result.v1");
		// Lease entries are local-only operational detail (§15.2).
		expect(toProtocolObservation(record("resource_lease_acquired_v1"))).toBeNull();
		expect(toProtocolObservation(record("resource_lease_released_v1"))).toBeNull();
	});

	it("covers every §20.2 kind exactly once", () => {
		expect(RESOURCE_OBSERVATION_KINDS).toHaveLength(10);
		expect(new Set(RESOURCE_OBSERVATION_KINDS).size).toBe(10);
	});
});
