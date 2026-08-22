import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	reduceShardRecords,
	validateWorkloadShardPlan,
	type WorkloadShardPlan,
	type WorkloadShardProjection,
	type WorkloadShardRecord,
	WorkloadShardTransitionError,
} from "./workload-shard-plan.ts";

/**
 * Durable workload shard journal (OMK v0.97.x roadmap §13.3/§13.5, M5/PR8).
 *
 * Append-only JSONL at `.omk/runs/<promptRunId>/workload-shards.jsonl` with
 * a per-line hash chain. Every append is validated against the in-memory
 * projection BEFORE it is written, and every load re-verifies parse, chain,
 * and §13.4 transition legality. Corruption fails closed (§21, §32 kill
 * criteria: never resume over a corrupt journal): the caller quarantines
 * the file and requires explicit repair; the journal itself is preserved
 * for §30.4 rollback.
 */

export const WORKLOAD_SHARD_JOURNAL_FILE = "workload-shards.jsonl";
const GENESIS_DIGEST = "workload-shard-genesis";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type WorkloadShardJournalErrorCode = "io" | "parse" | "chain" | "plan" | "transition";

export class WorkloadShardJournalError extends Error {
	readonly code: WorkloadShardJournalErrorCode;
	readonly line?: number;
	constructor(code: WorkloadShardJournalErrorCode, message: string, line?: number) {
		super(line === undefined ? message : `${message} (line ${line})`);
		this.name = "WorkloadShardJournalError";
		this.code = code;
		this.line = line;
	}
}

type JournalLine =
	| { readonly seq: number; readonly digest: string; readonly kind: "plan"; readonly plan: WorkloadShardPlan }
	| {
			readonly seq: number;
			readonly digest: string;
			readonly kind: "transition";
			readonly record: WorkloadShardRecord;
	  };

export function workloadShardJournalPath(cwd: string, promptRunId: string): string {
	if (!RUN_ID_PATTERN.test(promptRunId)) {
		throw new WorkloadShardJournalError("io", `invalid promptRunId for journal path: ${JSON.stringify(promptRunId)}`);
	}
	return path.join(cwd, ".omk", "runs", promptRunId, WORKLOAD_SHARD_JOURNAL_FILE);
}

interface JournalState {
	plan: WorkloadShardPlan | null;
	records: WorkloadShardRecord[];
	lastDigest: string;
	nextSeq: number;
}

export class WorkloadShardStore {
	private readonly journalPath: string;
	private state: JournalState | null = null;

	constructor(journalPath: string) {
		this.journalPath = journalPath;
	}

	static open(cwd: string, promptRunId: string): WorkloadShardStore {
		return new WorkloadShardStore(workloadShardJournalPath(cwd, promptRunId));
	}

	get filePath(): string {
		return this.journalPath;
	}

	/** Record the plan as the first line. Fails closed if any plan already exists. */
	appendPlan(plan: WorkloadShardPlan): void {
		const state = this.ensureLoaded();
		if (state.plan !== null) {
			throw new WorkloadShardJournalError("plan", "journal already contains a plan");
		}
		const planErrors = validateWorkloadShardPlan(plan);
		if (planErrors.length > 0) {
			throw new WorkloadShardJournalError("plan", `invalid plan: ${planErrors.join("; ")}`);
		}
		this.appendLine(state, { kind: "plan", plan });
		state.plan = plan;
	}

	/** Validate one §13.4 transition against the projection, then append it. */
	appendTransition(record: WorkloadShardRecord): void {
		const state = this.ensureLoaded();
		if (state.plan === null) {
			throw new WorkloadShardJournalError("plan", "cannot append a transition before the plan");
		}
		try {
			// Replaying with the candidate appended proves legality before any write.
			reduceShardRecords(state.plan, [...state.records, record]);
		} catch (error) {
			if (error instanceof WorkloadShardTransitionError) {
				throw new WorkloadShardJournalError("transition", error.message);
			}
			throw error;
		}
		this.appendLine(state, { kind: "transition", record });
		state.records.push(record);
	}

	/** Load and fully verify the journal. A missing file is an empty journal. */
	load(): {
		readonly plan: WorkloadShardPlan | null;
		readonly records: readonly WorkloadShardRecord[];
		readonly projections: ReadonlyMap<string, WorkloadShardProjection> | null;
	} {
		const state = this.ensureLoaded();
		const projections = state.plan === null ? null : reduceShardRecords(state.plan, state.records);
		return { plan: state.plan, records: [...state.records], projections };
	}

	/** §21 fail-closed path: move a corrupt journal aside; explicit repair required. */
	quarantine(): string | null {
		try {
			if (!fs.existsSync(this.journalPath)) {
				return null;
			}
			const target = `${this.journalPath}.corrupt-${Date.now()}`;
			fs.renameSync(this.journalPath, target);
			this.state = null;
			return target;
		} catch (error) {
			throw new WorkloadShardJournalError("io", `quarantine failed: ${String(error)}`);
		}
	}

	private ensureLoaded(): JournalState {
		if (this.state !== null) {
			return this.state;
		}
		const state: JournalState = { plan: null, records: [], lastDigest: GENESIS_DIGEST, nextSeq: 0 };
		if (fs.existsSync(this.journalPath)) {
			const raw = fs.readFileSync(this.journalPath, "utf8");
			const lines = raw.split("\n").filter((line) => line.trim() !== "");
			for (let index = 0; index < lines.length; index++) {
				const parsed = this.parseLine(lines[index], index + 1);
				this.verifyChain(state, parsed, index + 1);
				if (parsed.kind === "plan") {
					if (state.plan !== null) {
						throw new WorkloadShardJournalError("plan", "duplicate plan line", index + 1);
					}
					state.plan = parsed.plan;
				} else {
					if (state.plan === null) {
						throw new WorkloadShardJournalError("plan", "transition before plan", index + 1);
					}
					state.records.push(parsed.record);
				}
				state.lastDigest = parsed.digest;
				state.nextSeq = parsed.seq + 1;
			}
			if (state.plan !== null) {
				try {
					reduceShardRecords(state.plan, state.records);
				} catch (error) {
					throw new WorkloadShardJournalError("transition", `replay failed: ${String(error)}`);
				}
			}
		}
		this.state = state;
		return state;
	}

	private parseLine(line: string, lineNumber: number): JournalLine {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new WorkloadShardJournalError("parse", "journal line is not valid JSON", lineNumber);
		}
		const candidate = parsed as Partial<JournalLine>;
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			typeof candidate.seq !== "number" ||
			typeof candidate.digest !== "string" ||
			(candidate.kind !== "plan" && candidate.kind !== "transition")
		) {
			throw new WorkloadShardJournalError("parse", "journal line has an unknown shape", lineNumber);
		}
		return candidate as JournalLine;
	}

	private verifyChain(state: JournalState, line: JournalLine, lineNumber: number): void {
		if (line.seq !== state.nextSeq) {
			throw new WorkloadShardJournalError("chain", `sequence ${line.seq} != expected ${state.nextSeq}`, lineNumber);
		}
		const expected = chainDigest(state.lastDigest, line);
		if (line.digest !== expected) {
			throw new WorkloadShardJournalError("chain", "digest chain mismatch", lineNumber);
		}
	}

	private appendLine(
		state: JournalState,
		body: { kind: "plan"; plan: WorkloadShardPlan } | { kind: "transition"; record: WorkloadShardRecord },
	): void {
		const seq = state.nextSeq;
		const digest = chainDigest(state.lastDigest, { seq, ...body });
		const line: JournalLine =
			body.kind === "plan"
				? { seq, digest, kind: "plan", plan: body.plan }
				: { seq, digest, kind: "transition", record: body.record };
		try {
			fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
			fs.appendFileSync(this.journalPath, `${JSON.stringify(line)}\n`, "utf8");
		} catch (error) {
			throw new WorkloadShardJournalError("io", `append failed: ${String(error)}`);
		}
		state.lastDigest = digest;
		state.nextSeq = seq + 1;
	}
}

/** Digest over the previous digest plus the canonical payload (digest field excluded). */
function chainDigest(
	previousDigest: string,
	line: { readonly seq: number } & (
		| { readonly kind: "plan"; readonly plan: WorkloadShardPlan }
		| { readonly kind: "transition"; readonly record: WorkloadShardRecord }
	),
): string {
	const payload =
		line.kind === "plan"
			? JSON.stringify({ seq: line.seq, kind: line.kind, plan: line.plan })
			: JSON.stringify({ seq: line.seq, kind: line.kind, record: line.record });
	return createHash("sha256").update(`${previousDigest}\n${payload}`, "utf8").digest("hex");
}
