import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { type GeneratedProvider, getBundledModel, type Usage } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import type {
	AggregatedStats,
	CostTimeSeriesPoint,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
} from "./types";

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type UsageCost = Usage["cost"];
type CostTokens = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;

interface CostBackfillRow {
	id: number;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

let db: Database | null = null;

/**
 * Initialize the database and create tables.
 */
export async function initDb(): Promise<Database> {
	if (db) return db;

	// Ensure directory exists
	await fs.mkdir(getConfigRootDir(), { recursive: true });

	db = new Database(getStatsDbPath());
	db.exec("PRAGMA journal_mode = WAL");

	// Create tables
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL
		);
	`);

	const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
	if (!messageColumns.some(column => column.name === "premium_requests")) {
		db.exec("ALTER TABLE messages ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0");
	}
	db.exec("UPDATE messages SET premium_requests = 0 WHERE premium_requests IS NULL");
	backfillMissingCatalogCosts(db);
	return db;
}

function hasBillableCost(cost: ModelCost): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function getBundledModelCost(provider: string, modelId: string): ModelCost | null {
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	return model?.cost ?? null;
}

function getCatalogCost(provider: string, modelId: string): ModelCost | null {
	const primaryCost = getBundledModelCost(provider, modelId);
	if (primaryCost && hasBillableCost(primaryCost)) {
		return primaryCost;
	}

	if (provider === "openai-codex") {
		const openAICost = getBundledModelCost("openai", modelId);
		if (openAICost && hasBillableCost(openAICost)) {
			return openAICost;
		}
	}

	return null;
}

function calculateCatalogCost(provider: string, modelId: string, tokens: CostTokens): UsageCost | null {
	const cost = getCatalogCost(provider, modelId);
	if (!cost) return null;

	const input = (cost.input / 1_000_000) * tokens.input;
	const output = (cost.output / 1_000_000) * tokens.output;
	const cacheRead = (cost.cacheRead / 1_000_000) * tokens.cacheRead;
	const cacheWrite = (cost.cacheWrite / 1_000_000) * tokens.cacheWrite;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

function resolveStoredCost(stats: MessageStats): UsageCost {
	if (stats.usage.cost.total !== 0) {
		return stats.usage.cost;
	}

	return calculateCatalogCost(stats.provider, stats.model, stats.usage) ?? stats.usage.cost;
}

function backfillMissingCatalogCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
			FROM messages
			WHERE cost_total = 0 AND total_tokens > 0
		`)
		.all() as CostBackfillRow[];

	if (rows.length === 0) return;

	const update = database.prepare(`
		UPDATE messages
		SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?
		WHERE id = ?
	`);

	const applyBackfill = database.transaction(() => {
		for (const row of rows) {
			const cost = calculateCatalogCost(row.provider, row.model, {
				input: row.input_tokens,
				output: row.output_tokens,
				cacheRead: row.cache_read_tokens,
				cacheWrite: row.cache_write_tokens,
			});

			if (!cost || cost.total === 0) continue;

			update.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, row.id);
		}
	});

	applyBackfill();
}

/**
 * Get the stored offset for a session file.
 */
export function getFileOffset(sessionFile: string): { offset: number; lastModified: number } | null {
	if (!db) return null;

	const stmt = db.prepare("SELECT offset, last_modified FROM file_offsets WHERE session_file = ?");
	const row = stmt.get(sessionFile) as { offset: number; last_modified: number } | undefined;

	return row ? { offset: row.offset, lastModified: row.last_modified } : null;
}

/**
 * Update the stored offset for a session file.
 */
export function setFileOffset(sessionFile: string, offset: number, lastModified: number): void {
	if (!db) return;

	const stmt = db.prepare(`
		INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified)
		VALUES (?, ?, ?)
	`);
	stmt.run(sessionFile, offset, lastModified);
}

/**
 * Insert message stats into the database.
 */
export function insertMessageStats(stats: MessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT OR IGNORE INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const cost = resolveStoredCost(s);
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.model,
				s.provider,
				s.api,
				s.timestamp,
				s.duration,
				s.ttft,
				s.stopReason,
				s.errorMessage,
				s.usage.input,
				s.usage.output,
				s.usage.cacheRead,
				s.usage.cacheWrite,
				s.usage.totalTokens,
				s.usage.premiumRequests ?? 0,
				cost.input,
				cost.output,
				cost.cacheRead,
				cost.cacheWrite,
				cost.total,
			);
			if (result.changes > 0) inserted++;
		}
	});

	insert();
	return inserted;
}

/**
 * Build aggregated stats from query results.
 */
function buildAggregatedStats(rows: any[]): AggregatedStats {
	if (rows.length === 0) {
		return {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			totalCost: 0,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: 0,
			lastTimestamp: 0,
		};
	}

	const row = rows[0];
	const totalRequests = row.total_requests || 0;
	const failedRequests = row.failed_requests || 0;
	const successfulRequests = totalRequests - failedRequests;
	const totalInputTokens = row.total_input_tokens || 0;
	const totalCacheReadTokens = row.total_cache_read_tokens || 0;
	const totalPremiumRequests = row.total_premium_requests || 0;

	return {
		totalRequests,
		successfulRequests,
		failedRequests,
		errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
		totalInputTokens,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		cacheRate:
			totalInputTokens + totalCacheReadTokens > 0
				? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)
				: 0,
		totalCost: row.total_cost || 0,
		totalPremiumRequests,
		avgDuration: row.avg_duration,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
		firstTimestamp: row.first_timestamp || 0,
		lastTimestamp: row.last_timestamp || 0,
	};
}

/**
 * Get overall aggregated stats.
 */
export function getOverallStats(): AggregatedStats {
	if (!db) return buildAggregatedStats([]);

	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
	`);

	const rows = stmt.all();
	return buildAggregatedStats(rows);
}

/**
 * Get stats grouped by model.
 */
export function getStatsByModel(): ModelStats[] {
	if (!db) return [];

	const stmt = db.prepare(`
		SELECT
			model,
			provider,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		GROUP BY model, provider
		ORDER BY total_requests DESC
	`);

	const rows = stmt.all() as any[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get stats grouped by folder.
 */
export function getStatsByFolder(): FolderStats[] {
	if (!db) return [];

	const stmt = db.prepare(`
		SELECT
			folder,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		GROUP BY folder
		ORDER BY total_requests DESC
	`);

	const rows = stmt.all() as any[];
	return rows.map(row => ({
		folder: row.folder,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get hourly time series data.
 */
export function getTimeSeries(hours = 24): TimeSeriesPoint[] {
	if (!db) return [];

	const cutoff = Date.now() - hours * 60 * 60 * 1000;

	const stmt = db.prepare(`
		SELECT
			(timestamp / 3600000) * 3600000 as bucket,
			COUNT(*) as requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as errors,
			SUM(total_tokens) as tokens,
			SUM(cost_total) as cost
		FROM messages
		WHERE timestamp >= ?
		GROUP BY bucket
		ORDER BY bucket ASC
	`);

	const rows = stmt.all(cutoff) as any[];
	return rows.map(row => ({
		timestamp: row.bucket,
		requests: row.requests,
		errors: row.errors,
		tokens: row.tokens,
		cost: row.cost,
	}));
}

/**
 * Get daily performance time series data for the last N days.
 */
/**
 * Get daily model usage time series data for the last N days.
 */
export function getModelTimeSeries(days = 14): ModelTimeSeriesPoint[] {
	if (!db) return [];

	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			model,
			provider,
			COUNT(*) as requests
		FROM messages
		WHERE timestamp >= ?
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rows = stmt.all(cutoff) as any[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
	}));
}

/**
 * Get daily model performance time series data for the last N days.
 */
export function getModelPerformanceSeries(days = 14): ModelPerformancePoint[] {
	if (!db) return [];

	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			model,
			provider,
			COUNT(*) as requests,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		WHERE timestamp >= ?
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rows = stmt.all(cutoff) as any[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
	}));
}

/**
 * Get total message count.
 */
export function getMessageCount(): number {
	if (!db) return 0;
	const stmt = db.prepare("SELECT COUNT(*) as count FROM messages");
	const row = stmt.get() as { count: number };
	return row.count;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function rowToMessageStats(row: any): MessageStats {
	return {
		id: row.id,
		sessionFile: row.session_file,
		entryId: row.entry_id,
		folder: row.folder,
		model: row.model,
		provider: row.provider,
		api: row.api,
		timestamp: row.timestamp,
		duration: row.duration,
		ttft: row.ttft,
		stopReason: row.stop_reason as any,
		errorMessage: row.error_message,
		usage: {
			input: row.input_tokens,
			output: row.output_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_write_tokens,
			totalTokens: row.total_tokens,
			premiumRequests: row.premium_requests ?? 0,
			cost: {
				input: row.cost_input,
				output: row.cost_output,
				cacheRead: row.cost_cache_read,
				cacheWrite: row.cost_cache_write,
				total: row.cost_total,
			},
		},
	};
}

export function getRecentRequests(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as any[]).map(rowToMessageStats);
}

export function getRecentErrors(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		WHERE stop_reason = 'error'
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as any[]).map(rowToMessageStats);
}

export function getMessageById(id: number): MessageStats | null {
	if (!db) return null;
	const stmt = db.prepare("SELECT * FROM messages WHERE id = ?");
	const row = stmt.get(id);
	return row ? rowToMessageStats(row) : null;
}

/**
 * Get daily cost time series data for the last N days, broken down by model.
 */
export function getCostTimeSeries(days = 90): CostTimeSeriesPoint[] {
	if (!db) return [];

	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			model,
			provider,
			SUM(cost_total) as cost,
			SUM(cost_input) as cost_input,
			SUM(cost_output) as cost_output,
			SUM(cost_cache_read) as cost_cache_read,
			SUM(cost_cache_write) as cost_cache_write,
			COUNT(*) as requests
		FROM messages
		WHERE timestamp >= ?
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rows = stmt.all(cutoff) as any[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		cost: row.cost,
		costInput: row.cost_input,
		costOutput: row.cost_output,
		costCacheRead: row.cost_cache_read,
		costCacheWrite: row.cost_cache_write,
		requests: row.requests,
	}));
}
