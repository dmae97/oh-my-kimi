import * as fs from "node:fs";
import * as path from "node:path";
import type { CompletionSoundResult } from "./completion-sound.ts";
import type { PromptSettledEvent } from "./prompt-settlement.ts";
import type { ResourceAdmissionDecision } from "./resource-admission.ts";
import type { WorkloadClassification } from "./workload-classifier.ts";

/**
 * Local-only resource observation journal (roadmap §15.1/§15.2/§20.2).
 *
 * A dedicated JSONL artifact under `.omk/runs/<promptRunId>/` — deliberately
 * NOT the hash-chained run journal: §15.2 restricts raw host facts to a
 * separate local-only artifact, and extending the run journal's closed audit
 * union would invalidate old readers. Shard plan/transition entries stay in
 * `workload-shards.jsonl` (they already journal there); this file carries
 * the remaining §20.2 entries.
 *
 * Privacy (§15.2, §20.3, §30): facts are flat primitives only — pressure
 * levels, caps, digests, durations, reason codes. Never raw memory/cpu
 * numbers, hostnames, usernames, or command text. Observability is
 * fail-open: a write/read failure degrades to diagnostics, never breaks the
 * run (probe failure is non-fatal by contract).
 */

export const RESOURCE_OBSERVATION_JOURNAL_FILE = "resource-observations.jsonl";

/** §20.2 journal entry kinds handled by this artifact. */
export const RESOURCE_OBSERVATION_KINDS = [
	"resource_snapshot_v1",
	"resource_admission_v1",
	"resource_lease_acquired_v1",
	"resource_lease_released_v1",
	"workload_classification_v1",
	"workload_permit_wait_v1",
	"workload_permit_acquired_v1",
	"workload_permit_released_v1",
	"prompt_settled_v1",
	"completion_sound_result_v1",
] as const;

export type ResourceObservationKind = (typeof RESOURCE_OBSERVATION_KINDS)[number];

export type ResourceObservationFacts = Readonly<Record<string, string | number | boolean | null>>;

export interface ResourceObservationRecord {
	readonly schemaVersion: 1;
	readonly seq: number;
	readonly kind: ResourceObservationKind;
	readonly at: string;
	readonly promptRunId: string;
	readonly facts: ResourceObservationFacts;
}

/** §15.1 protocol observation projection of one journal record. */
export interface ResourceProtocolObservation {
	readonly kind:
		| "resource_snapshot.v1"
		| "resource_admission.v1"
		| "workload_classification.v1"
		| "workload_permit.v1"
		| "prompt_settled.v1"
		| "notification_result.v1";
	readonly facts: ResourceObservationFacts;
}

const PROTOCOL_KIND_BY_JOURNAL_KIND: Readonly<
	Partial<Record<ResourceObservationKind, ResourceProtocolObservation["kind"]>>
> = {
	resource_snapshot_v1: "resource_snapshot.v1",
	resource_admission_v1: "resource_admission.v1",
	workload_classification_v1: "workload_classification.v1",
	workload_permit_wait_v1: "workload_permit.v1",
	workload_permit_acquired_v1: "workload_permit.v1",
	workload_permit_released_v1: "workload_permit.v1",
	prompt_settled_v1: "prompt_settled.v1",
	completion_sound_result_v1: "notification_result.v1",
};

/**
 * Project a journal record onto the §15.1 protocol observation surface.
 * Lease entries are local-only operational detail and project to null.
 */
export function toProtocolObservation(record: ResourceObservationRecord): ResourceProtocolObservation | null {
	const kind = PROTOCOL_KIND_BY_JOURNAL_KIND[record.kind];
	return kind === undefined ? null : { kind, facts: record.facts };
}

/** §15.2: probe health and digest only — raw host values never leave the process. */
export function snapshotObservationFacts(snapshot: {
	readonly systemCpuPercent: number | null;
	readonly processAvailableMemoryBytes: number | null;
	readonly hostFreeMemoryBytes: number | null;
	readonly heapLimitBytes: number;
}): ResourceObservationFacts {
	return {
		cpuProbe: snapshot.systemCpuPercent !== null,
		memoryProbe: snapshot.processAvailableMemoryBytes !== null || snapshot.hostFreeMemoryBytes !== null,
		heapLimitKnown: snapshot.heapLimitBytes > 0,
	};
}

/** §15.2 example shape: pressure, action, caps, and bounded reason codes. */
export function admissionObservationFacts(decision: ResourceAdmissionDecision): ResourceObservationFacts {
	return {
		decisionId: decision.decisionId,
		snapshotDigest: decision.snapshotDigest,
		pressure: decision.pressure,
		action: decision.action,
		maxToolConcurrency: decision.maxToolConcurrency,
		maxParallelLanes: decision.maxParallelLanes,
		maxHeavyProcesses: decision.maxHeavyProcesses,
		reasons: decision.reasons.slice(0, 8).join(","),
	};
}

export function classificationObservationFacts(classification: WorkloadClassification): ResourceObservationFacts {
	return {
		workloadClass: classification.workloadClass,
		commandFamily: classification.commandFamily,
		complexity: classification.complexity,
		safeToAutoShard: classification.safeToAutoShard,
		reasonCodes: classification.reasonCodes.slice(0, 8).join(","),
	};
}

export function settledObservationFacts(event: PromptSettledEvent): ResourceObservationFacts {
	return {
		outcome: event.outcome,
		durationMs: event.durationMs,
		...(event.terminationKind !== undefined ? { terminationKind: event.terminationKind } : {}),
	};
}

export function soundObservationFacts(result: CompletionSoundResult): ResourceObservationFacts {
	return {
		backend: result.backend,
		attempted: result.attempted,
		success: result.success,
		...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic.slice(0, 120) } : {}),
	};
}

const MAX_LINE_BYTES = 8 * 1024;
const MAX_RECORDS = 10_000;

export interface ResourceObservationLoadResult {
	readonly records: readonly ResourceObservationRecord[];
	readonly diagnostics: readonly string[];
}

export class ResourceObservationJournal {
	private readonly journalPath: string;
	private readonly promptRunId: string;
	private readonly now: () => Date;
	private seq = 0;
	private disabled = false;

	constructor(journalPath: string, promptRunId: string, now: () => Date = () => new Date()) {
		this.journalPath = journalPath;
		this.promptRunId = promptRunId;
		this.now = now;
	}

	static open(cwd: string, promptRunId: string, now?: () => Date): ResourceObservationJournal {
		return new ResourceObservationJournal(
			path.join(cwd, ".omk", "runs", promptRunId, RESOURCE_OBSERVATION_JOURNAL_FILE),
			promptRunId,
			now,
		);
	}

	get filePath(): string {
		return this.journalPath;
	}

	/** Fail-open append: returns false (and stops trying) instead of throwing. */
	record(kind: ResourceObservationKind, facts: ResourceObservationFacts): boolean {
		if (this.disabled || this.seq >= MAX_RECORDS) return false;
		const entry: ResourceObservationRecord = {
			schemaVersion: 1,
			seq: this.seq + 1,
			kind,
			at: this.now().toISOString(),
			promptRunId: this.promptRunId,
			facts,
		};
		const line = `${JSON.stringify(entry)}\n`;
		if (line.length > MAX_LINE_BYTES) return false;
		try {
			fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
			fs.appendFileSync(this.journalPath, line, "utf8");
			this.seq = entry.seq;
			return true;
		} catch {
			// Observability must never break the run; stop retrying this run.
			this.disabled = true;
			return false;
		}
	}

	/** Fail-open load: malformed lines become diagnostics, never throws. */
	load(): ResourceObservationLoadResult {
		let raw: string;
		try {
			raw = fs.readFileSync(this.journalPath, "utf8");
		} catch {
			return { records: [], diagnostics: [] };
		}
		const records: ResourceObservationRecord[] = [];
		const diagnostics: string[] = [];
		const lines = raw.split("\n");
		for (let index = 0; index < lines.length && records.length < MAX_RECORDS; index++) {
			const line = lines[index].trim();
			if (line === "") continue;
			const parsed = parseResourceObservationLine(line);
			if (parsed === null) {
				diagnostics.push(`line ${index + 1}: invalid observation record`);
				continue;
			}
			records.push(parsed);
		}
		return { records, diagnostics };
	}
}

const KIND_SET: ReadonlySet<string> = new Set(RESOURCE_OBSERVATION_KINDS);

export function parseResourceObservationLine(line: string): ResourceObservationRecord | null {
	if (line.length > MAX_LINE_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1) return null;
	if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 1) return null;
	if (typeof record.kind !== "string" || !KIND_SET.has(record.kind)) return null;
	if (typeof record.at !== "string" || typeof record.promptRunId !== "string") return null;
	if (typeof record.facts !== "object" || record.facts === null || Array.isArray(record.facts)) return null;
	for (const factValue of Object.values(record.facts)) {
		const kind = typeof factValue;
		if (factValue !== null && kind !== "string" && kind !== "number" && kind !== "boolean") return null;
	}
	return record as unknown as ResourceObservationRecord;
}
