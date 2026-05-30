import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type DatabasePath, openDatabase } from "../db";

export const VERACITY_WEIGHTS = Object.freeze({
	stated: 1.0,
	inferred: 0.7,
	tool: 0.5,
	imported: 0.6,
	unknown: 0.8,
});

export type Veracity = keyof typeof VERACITY_WEIGHTS;

export const VERACITY_ALLOWED: Record<Veracity, true> = Object.freeze({
	stated: true,
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
});

const VERACITY_WARN_VALUE_CAP = 80;
const TX_DEPTH = Symbol("mnemosyne.veracity.txDepth");

type TxDatabase = Database & {
	readonly inTransaction?: boolean;
	readonly in_transaction?: boolean;
	[TX_DEPTH]?: number;
};

export interface ConsolidatedFact {
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly mention_count: number;
	readonly first_seen: string | null;
	readonly last_seen: string | null;
	readonly sources: string[];
	readonly veracity: string;
	readonly superseded: boolean;
	readonly id: string | null;
}

interface ConsolidatedFactRow {
	readonly id: string;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly mention_count: number;
	readonly first_seen: string | null;
	readonly last_seen: string | null;
	readonly sources_json: string | null;
	readonly veracity: string;
	readonly superseded_by: string | null;
}

interface ConflictRow {
	readonly id: number;
	readonly fact_a_id: string;
	readonly fact_b_id: string;
	readonly conflict_type: string | null;
	readonly resolution: string | null;
	readonly resolved_at: string | null;
	readonly created_at: string | null;
}

export interface Conflict {
	readonly id: number;
	readonly fact_a_id: string;
	readonly fact_b_id: string;
	readonly type: string | null;
	readonly created_at: string | null;
}

export interface ConsolidationStats {
	readonly active_facts: number;
	readonly superseded_facts: number;
	readonly unresolved_conflicts: number;
	readonly avg_confidence: number;
	readonly avg_mentions: number;
}

function isVeracity(value: string): value is Veracity {
	return Object.hasOwn(VERACITY_ALLOWED, value);
}

function sqliteInTransaction(db: Database): boolean {
	const txDb = db as TxDatabase;
	return txDb.inTransaction === true || txDb.in_transaction === true || (txDb[TX_DEPTH] ?? 0) > 0;
}

function parseSources(raw: string | null): string[] {
	if (raw === null || raw === "") return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: string[] = [];
		for (const item of parsed) {
			if (typeof item === "string") out.push(item);
		}
		return out;
	} catch {
		return [];
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

export function compute_fact_id(subject: string, predicate: string, object: string): string {
	for (const [name, value] of [
		["subject", subject],
		["predicate", predicate],
		["object", object],
	] as const) {
		if (typeof value !== "string") {
			throw new TypeError(`compute_fact_id: ${name} must be a str, got ${typeof value}`);
		}
		if (value === "") throw new RangeError(`compute_fact_id: ${name} must be non-empty`);
	}

	const chunks: Buffer[] = [];
	for (const value of [subject, predicate, object]) {
		const bytes = Buffer.from(value.normalize("NFC"), "utf8");
		chunks.push(Buffer.from(`${bytes.length}:`, "ascii"), bytes);
	}
	return `cf_${createHash("sha256").update(Buffer.concat(chunks)).digest("hex").slice(0, 24)}`;
}

export const computeFactId = compute_fact_id;

export function clamp_veracity(raw: unknown, context = "veracity"): Veracity {
	if (raw === null || raw === undefined) return "unknown";
	const norm = String(raw).trim().toLowerCase();
	if (norm === "") return "unknown";
	if (isVeracity(norm)) return norm;
	const rawString = String(raw);
	const rawForLog =
		rawString.length > VERACITY_WARN_VALUE_CAP
			? `${rawString.slice(0, VERACITY_WARN_VALUE_CAP)}...[truncated]`
			: rawString;
	console.warn(`${context} received unknown veracity ${JSON.stringify(rawForLog)}; clamping to 'unknown'`);
	return "unknown";
}

export const clampVeracity = clamp_veracity;

export function aggregate_veracity(sourceVeracities: readonly string[] | null | undefined): Veracity {
	if (sourceVeracities === null || sourceVeracities === undefined || sourceVeracities.length === 0) return "unknown";
	const valid = sourceVeracities.filter(isVeracity);
	if (valid.length === 0) return "unknown";
	const nonUnknown = valid.filter(v => v !== "unknown");
	const candidates = nonUnknown.length === 0 ? valid : nonUnknown;
	const counts = new Map<Veracity, number>();
	for (const value of candidates) counts.set(value, (counts.get(value) ?? 0) + 1);
	let max = 0;
	for (const count of counts.values()) if (count > max) max = count;
	let winner: Veracity | null = null;
	for (const [value, count] of counts) {
		if (count !== max) continue;
		if (winner === null || VERACITY_WEIGHTS[value] < VERACITY_WEIGHTS[winner]) winner = value;
	}
	return winner ?? "unknown";
}

export const aggregateVeracity = aggregate_veracity;

export class VeracityConsolidator {
	readonly conn: Database;
	readonly db_path: DatabasePath;
	readonly owns_connection: boolean;

	constructor(db_path: DatabasePath = ":memory:", conn?: Database) {
		this.db_path = db_path;
		this.conn = conn ?? openDatabase(db_path, { create: true, readwrite: true, strict: true, pragmas: true });
		this.owns_connection = conn === undefined;
		this._init_tables();
	}

	_init_tables(): void {
		this.conn.run(`
			CREATE TABLE IF NOT EXISTS consolidated_facts (
				id TEXT PRIMARY KEY,
				subject TEXT NOT NULL,
				predicate TEXT NOT NULL,
				object TEXT NOT NULL,
				confidence REAL DEFAULT 0.5,
				mention_count INTEGER DEFAULT 1,
				first_seen TEXT,
				last_seen TEXT,
				sources_json TEXT,
				veracity TEXT DEFAULT 'unknown',
				superseded_by TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		this.conn.run("CREATE INDEX IF NOT EXISTS idx_cf_subject ON consolidated_facts(subject)");
		this.conn.run("CREATE INDEX IF NOT EXISTS idx_cf_predicate ON consolidated_facts(predicate)");
		this.conn.run("CREATE INDEX IF NOT EXISTS idx_cf_object ON consolidated_facts(object)");
		this.conn.run(`
			CREATE TABLE IF NOT EXISTS conflicts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				fact_a_id TEXT NOT NULL,
				fact_b_id TEXT NOT NULL,
				conflict_type TEXT,
				resolution TEXT,
				resolved_at TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
	}

	_serialized_write<T>(body: () => T): T {
		const conn = this.conn;
		if (sqliteInTransaction(conn)) return body();

		let started = false;
		try {
			conn.exec("BEGIN IMMEDIATE");
			started = true;
			(conn as TxDatabase)[TX_DEPTH] = ((conn as TxDatabase)[TX_DEPTH] ?? 0) + 1;
			const result = body();
			conn.exec("COMMIT");
			return result;
		} catch (error) {
			if (
				!started &&
				error instanceof Error &&
				/within a transaction|transaction.*active|cannot start/i.test(error.message)
			) {
				return body();
			}
			if (started) {
				try {
					conn.exec("ROLLBACK");
				} catch {
					// Preserve original error.
				}
			}
			throw error;
		} finally {
			if (started) {
				const txDb = conn as TxDatabase;
				const depth = (txDb[TX_DEPTH] ?? 1) - 1;
				if (depth > 0) txDb[TX_DEPTH] = depth;
				else delete txDb[TX_DEPTH];
			}
		}
	}

	bayesian_update(current_confidence: number, veracity: string): number {
		const weight = isVeracity(veracity) ? VERACITY_WEIGHTS[veracity] : VERACITY_WEIGHTS.unknown;
		const increment = (1.0 - current_confidence) * weight * 0.3;
		return Math.min(current_confidence + increment, 1.0);
	}

	consolidate_fact(
		subject: string,
		predicate: string,
		object: string,
		veracity = "unknown",
		source?: string | null,
	): ConsolidatedFact {
		return this._serialized_write(() => {
			const existing = this.conn
				.query("SELECT * FROM consolidated_facts WHERE subject = ? AND predicate = ? AND object = ?")
				.get(subject, predicate, object) as ConsolidatedFactRow | null;
			const now = nowIso();

			if (existing !== null) {
				const newConfidence = this.bayesian_update(existing.confidence, veracity);
				const newCount = existing.mention_count + 1;
				const sources = parseSources(existing.sources_json);
				if (source !== undefined && source !== null && source !== "" && !sources.includes(source))
					sources.push(source);
				this.conn
					.query(`
						UPDATE consolidated_facts
						SET confidence = ?, mention_count = ?, last_seen = ?, sources_json = ?, veracity = ?, updated_at = ?
						WHERE id = ?
					`)
					.run(newConfidence, newCount, now, JSON.stringify(sources), veracity, now, existing.id);
				return {
					subject,
					predicate,
					object,
					confidence: newConfidence,
					mention_count: newCount,
					first_seen: existing.first_seen,
					last_seen: now,
					sources,
					veracity,
					superseded: existing.superseded_by !== null,
					id: existing.id,
				};
			}

			const conflicts = this.conn
				.query("SELECT * FROM consolidated_facts WHERE subject = ? AND predicate = ? AND object != ?")
				.all(subject, predicate, object) as ConsolidatedFactRow[];
			const factId = compute_fact_id(subject, predicate, object);
			const weight = isVeracity(veracity) ? VERACITY_WEIGHTS[veracity] : VERACITY_WEIGHTS.unknown;
			const baseConfidence = weight * 0.5;
			const sources = source !== undefined && source !== null && source !== "" ? [source] : [];
			this.conn
				.query(`
					INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(factId, subject, predicate, object, baseConfidence, 1, now, now, JSON.stringify(sources), veracity);
			for (const conflict of conflicts) this._record_conflict(factId, conflict.id, "contradiction", false);
			return {
				subject,
				predicate,
				object,
				confidence: baseConfidence,
				mention_count: 1,
				first_seen: now,
				last_seen: now,
				sources,
				veracity,
				superseded: false,
				id: factId,
			};
		});
	}

	_record_conflict(fact_a_id: string, fact_b_id: string, conflict_type: string, commit = true): void {
		this.conn
			.query("INSERT INTO conflicts (fact_a_id, fact_b_id, conflict_type) VALUES (?, ?, ?)")
			.run(fact_a_id, fact_b_id, conflict_type);
		void commit;
	}

	resolve_conflict(conflict_id: number, winning_fact_id: string): void {
		this._serialized_write(() => {
			const conflict = this.conn
				.query("SELECT * FROM conflicts WHERE id = ?")
				.get(conflict_id) as ConflictRow | null;
			if (conflict === null) return;
			if (conflict.resolution !== null) {
				console.warn(
					`resolve_conflict: conflict ${conflict_id} already resolved (resolution=${JSON.stringify(conflict.resolution)}); ignoring re-resolution attempt with winning_fact_id=${JSON.stringify(winning_fact_id)}`,
				);
				return;
			}
			let losingId: string;
			if (winning_fact_id === conflict.fact_a_id) losingId = conflict.fact_b_id;
			else if (winning_fact_id === conflict.fact_b_id) losingId = conflict.fact_a_id;
			else {
				console.warn(
					`resolve_conflict: winning_fact_id ${JSON.stringify(winning_fact_id)} matches neither fact_a_id ${JSON.stringify(conflict.fact_a_id)} nor fact_b_id ${JSON.stringify(conflict.fact_b_id)}; declining to resolve`,
				);
				return;
			}
			const now = nowIso();
			this.conn
				.query("UPDATE consolidated_facts SET superseded_by = ?, updated_at = ? WHERE id = ?")
				.run(winning_fact_id, now, losingId);
			this.conn
				.query("UPDATE conflicts SET resolution = ?, resolved_at = ? WHERE id = ?")
				.run(`superseded_by_${winning_fact_id}`, now, conflict_id);
		});
	}

	get_conflicts(): Conflict[] {
		const rows = this.conn
			.query("SELECT * FROM conflicts WHERE resolution IS NULL ORDER BY created_at DESC")
			.all() as ConflictRow[];
		return rows.map(row => ({
			id: row.id,
			fact_a_id: row.fact_a_id,
			fact_b_id: row.fact_b_id,
			type: row.conflict_type,
			created_at: row.created_at,
		}));
	}

	get_consolidated_facts(subject?: string | null, min_confidence = 0.5): ConsolidatedFact[] {
		const rows =
			subject !== undefined && subject !== null
				? (this.conn
						.query(`
							SELECT * FROM consolidated_facts
							WHERE subject = ? AND confidence >= ? AND superseded_by IS NULL
							ORDER BY confidence DESC, mention_count DESC
						`)
						.all(subject, min_confidence) as ConsolidatedFactRow[])
				: (this.conn
						.query(`
							SELECT * FROM consolidated_facts
							WHERE confidence >= ? AND superseded_by IS NULL
							ORDER BY confidence DESC, mention_count DESC
						`)
						.all(min_confidence) as ConsolidatedFactRow[]);
		return rows.map(row => ({
			subject: row.subject,
			predicate: row.predicate,
			object: row.object,
			confidence: row.confidence,
			mention_count: row.mention_count,
			first_seen: row.first_seen,
			last_seen: row.last_seen,
			sources: parseSources(row.sources_json),
			veracity: row.veracity,
			superseded: row.superseded_by !== null,
			id: row.id,
		}));
	}

	get_high_confidence_summary(subject: string, threshold = 0.8): string {
		const facts = this.get_consolidated_facts(subject, threshold);
		if (facts.length === 0) return `No high-confidence facts about ${subject}.`;
		const lines = [`High-confidence facts about ${subject}:`];
		for (const fact of facts) {
			lines.push(
				`  - ${fact.subject} ${fact.predicate} ${fact.object} (conf: ${fact.confidence.toFixed(2)}, mentions: ${fact.mention_count})`,
			);
		}
		return lines.join("\n");
	}

	run_consolidation_pass(): void {
		this._serialized_write(() => {
			const primaryRows = this.conn
				.query(`
					SELECT * FROM consolidated_facts
					WHERE mention_count > 2 AND superseded_by IS NULL
					ORDER BY mention_count DESC
				`)
				.all() as ConsolidatedFactRow[];
			for (const row of primaryRows) {
				const conflicts = this.conn
					.query(`
						SELECT * FROM consolidated_facts
						WHERE subject = ? AND predicate = ? AND object != ? AND superseded_by IS NULL
					`)
					.all(row.subject, row.predicate, row.object) as ConsolidatedFactRow[];
				for (const conflict of conflicts) {
					if (row.confidence > conflict.confidence) this.resolve_conflict_by_facts(row.id, conflict.id);
				}
			}
		});
	}

	resolve_conflict_by_facts(winning_id: string, losing_id: string): void {
		this._serialized_write(() => {
			this.conn
				.query("UPDATE consolidated_facts SET superseded_by = ?, updated_at = ? WHERE id = ?")
				.run(winning_id, nowIso(), losing_id);
		});
	}

	get_stats(): ConsolidationStats {
		const active = this.conn
			.query("SELECT COUNT(*) AS count FROM consolidated_facts WHERE superseded_by IS NULL")
			.get() as { count: number };
		const superseded = this.conn
			.query("SELECT COUNT(*) AS count FROM consolidated_facts WHERE superseded_by IS NOT NULL")
			.get() as { count: number };
		const unresolved = this.conn.query("SELECT COUNT(*) AS count FROM conflicts WHERE resolution IS NULL").get() as {
			count: number;
		};
		const avgConfidence = this.conn
			.query("SELECT AVG(confidence) AS avg FROM consolidated_facts WHERE superseded_by IS NULL")
			.get() as { avg: number | null };
		const avgMentions = this.conn
			.query("SELECT AVG(mention_count) AS avg FROM consolidated_facts WHERE superseded_by IS NULL")
			.get() as { avg: number | null };
		return {
			active_facts: active.count,
			superseded_facts: superseded.count,
			unresolved_conflicts: unresolved.count,
			avg_confidence: Math.round((avgConfidence.avg ?? 0) * 1000) / 1000,
			avg_mentions: Math.round((avgMentions.avg ?? 0) * 100) / 100,
		};
	}

	close(): void {
		this.conn.close();
	}
}
