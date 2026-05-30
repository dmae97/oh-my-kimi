import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_LOG_DIR = join(homedir(), ".mnemosyne", "data");
export const DEFAULT_LOG_DB = join(DEFAULT_LOG_DIR, "cost_log.db");

export interface CostStats {
	total_calls: number;
	total_memories_injected: number;
	total_tokens: number;
	total_estimated_cost_usd: number;
}

type AggregateRow = {
	calls: number | null;
	total_memories: number | null;
	total_tokens: number | null;
	total_cost: number | null;
};

export function _get_conn(db_path?: string): Database {
	const path = db_path ?? DEFAULT_LOG_DB;
	mkdirSync(dirname(path), { recursive: true });
	return new Database(path, { create: true, readwrite: true, strict: true });
}

export function init_cost_log(db_path?: string): void {
	const conn = _get_conn(db_path);
	try {
		conn.run(`
			CREATE TABLE IF NOT EXISTS cost_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				memory_count INTEGER,
				token_count INTEGER,
				estimated_cost_usd REAL,
				model TEXT DEFAULT 'default',
				timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
	} finally {
		conn.close();
	}
}

export const initCostLog = init_cost_log;

export function log_cost(
	session_id: string,
	memory_count: number,
	token_count: number,
	estimated_cost_usd: number,
	model = "default",
	db_path?: string,
): void {
	init_cost_log(db_path);
	const conn = _get_conn(db_path);
	try {
		conn
			.query(`
				INSERT INTO cost_entries (session_id, memory_count, token_count, estimated_cost_usd, model, timestamp)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(session_id, memory_count, token_count, estimated_cost_usd, model, localIsoTimestamp(new Date()));
	} finally {
		conn.close();
	}
}

export const logCost = log_cost;

export function get_cost_stats(session_id?: string, db_path?: string): CostStats {
	init_cost_log(db_path);
	const conn = _get_conn(db_path);
	try {
		const row = (
			session_id
				? conn
						.query(`
						SELECT COUNT(*) as calls, SUM(memory_count) as total_memories,
							SUM(token_count) as total_tokens, SUM(estimated_cost_usd) as total_cost
						FROM cost_entries WHERE session_id = ?
					`)
						.get(session_id)
				: conn
						.query(`
						SELECT COUNT(*) as calls, SUM(memory_count) as total_memories,
							SUM(token_count) as total_tokens, SUM(estimated_cost_usd) as total_cost
						FROM cost_entries
					`)
						.get()
		) as AggregateRow | null;

		return {
			total_calls: row?.calls ?? 0,
			total_memories_injected: row?.total_memories ?? 0,
			total_tokens: row?.total_tokens ?? 0,
			total_estimated_cost_usd: Math.round((row?.total_cost ?? 0) * 1_000_000) / 1_000_000,
		};
	} finally {
		conn.close();
	}
}

export const getCostStats = get_cost_stats;

function localIsoTimestamp(date: Date): string {
	const offsetMs = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offsetMs).toISOString().replace("Z", "");
}
