import * as fs from "node:fs";
import {
	getRecentErrors as dbGetRecentErrors,
	getRecentRequests as dbGetRecentRequests,
	getCostTimeSeries,
	getFileOffset,
	getMessageById,
	getMessageCount,
	getModelPerformanceSeries,
	getModelTimeSeries,
	getOverallStats,
	getStatsByFolder,
	getStatsByModel,
	getTimeSeries,
	initDb,
	insertMessageStats,
	setFileOffset,
} from "./db";
import { getSessionEntry, listAllSessionFiles, parseSessionFile } from "./parser";
import type { DashboardStats, MessageStats, RequestDetails } from "./types";

/**
 * Sync a single session file to the database.
 * Only processes new entries since the last sync.
 */
async function syncSessionFile(sessionFile: string): Promise<number> {
	// Get file stats
	let fileStats: fs.Stats;
	try {
		fileStats = await fs.promises.stat(sessionFile);
	} catch {
		return 0;
	}

	const lastModified = fileStats.mtimeMs;

	// Check if file has changed since last sync
	const stored = getFileOffset(sessionFile);
	if (stored && stored.lastModified >= lastModified) {
		return 0; // File hasn't changed
	}

	// Parse file from last offset
	const fromOffset = stored?.offset ?? 0;
	const { stats, newOffset } = await parseSessionFile(sessionFile, fromOffset);

	if (stats.length > 0) {
		insertMessageStats(stats);
	}

	// Update offset tracker
	setFileOffset(sessionFile, newOffset, lastModified);

	return stats.length;
}

/**
 * Sync all session files to the database.
 * Returns the number of new entries processed.
 */
export async function syncAllSessions(): Promise<{ processed: number; files: number }> {
	await initDb();

	const files = await listAllSessionFiles();
	let totalProcessed = 0;
	let filesProcessed = 0;

	for (const file of files) {
		const count = await syncSessionFile(file);
		if (count > 0) {
			totalProcessed += count;
			filesProcessed++;
		}
	}

	return { processed: totalProcessed, files: filesProcessed };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

interface TimeRangeConfig {
	timeSeriesHours: number;
	timeSeriesBucketMs: number;
	modelSeriesDays: number;
	modelPerformanceDays: number;
	costSeriesDays: number;
	cutoff: number | null;
}

const DEFAULT_TIME_RANGE: TimeRange = "24h";

const TIME_RANGE_TO_CONFIG: Record<TimeRange, Omit<TimeRangeConfig, "cutoff">> = {
	"1h": {
		timeSeriesHours: 1,
		timeSeriesBucketMs: HOUR_MS,
		modelSeriesDays: 1,
		modelPerformanceDays: 1,
		costSeriesDays: 1,
	},
	"24h": {
		timeSeriesHours: 24,
		timeSeriesBucketMs: HOUR_MS,
		modelSeriesDays: 1,
		modelPerformanceDays: 1,
		costSeriesDays: 1,
	},
	"7d": {
		timeSeriesHours: 24 * 7,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 7,
		modelPerformanceDays: 7,
		costSeriesDays: 7,
	},
	"30d": {
		timeSeriesHours: 24 * 30,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 30,
		modelPerformanceDays: 30,
		costSeriesDays: 30,
	},
	"90d": {
		timeSeriesHours: 24 * 90,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 90,
		modelPerformanceDays: 90,
		costSeriesDays: 90,
	},
	all: {
		timeSeriesHours: 24 * 3650,
		timeSeriesBucketMs: DAY_MS,
		modelSeriesDays: 3650,
		modelPerformanceDays: 3650,
		costSeriesDays: 3650,
	},
};

function getTimeRangeConfig(range?: string | null): TimeRangeConfig {
	const normalized = range?.trim().toLowerCase() ?? DEFAULT_TIME_RANGE;
	const config = TIME_RANGE_TO_CONFIG[normalized as TimeRange];
	if (config) {
		const cutoff = normalized === "all" ? null : Date.now() - Math.max(1, config.timeSeriesHours * 60 * 60 * 1000);
		return { ...config, cutoff };
	}

	const fallbackConfig = TIME_RANGE_TO_CONFIG[DEFAULT_TIME_RANGE];
	return {
		...fallbackConfig,
		cutoff: Date.now() - fallbackConfig.timeSeriesHours * 60 * 60 * 1000,
	};
}

/**
 * Get all dashboard stats.
 */
export async function getDashboardStats(range?: string | null): Promise<DashboardStats> {
	await initDb();
	const { timeSeriesHours, timeSeriesBucketMs, modelSeriesDays, modelPerformanceDays, costSeriesDays, cutoff } =
		getTimeRangeConfig(range);

	return {
		overall: getOverallStats(cutoff ?? undefined),
		byModel: getStatsByModel(cutoff ?? undefined),
		byFolder: getStatsByFolder(cutoff ?? undefined),
		timeSeries: getTimeSeries(timeSeriesHours, cutoff, timeSeriesBucketMs),
		modelSeries: getModelTimeSeries(modelSeriesDays, cutoff),
		modelPerformanceSeries: getModelPerformanceSeries(modelPerformanceDays, cutoff),
		costSeries: getCostTimeSeries(costSeriesDays, cutoff),
	};
}

export async function getOverviewStats(range?: string | null): Promise<Pick<DashboardStats, "overall" | "timeSeries">> {
	await initDb();
	const { timeSeriesHours, timeSeriesBucketMs, cutoff } = getTimeRangeConfig(range);

	return {
		overall: getOverallStats(cutoff ?? undefined),
		timeSeries: getTimeSeries(timeSeriesHours, cutoff, timeSeriesBucketMs),
	};
}

export async function getModelDashboardStats(
	range?: string | null,
): Promise<Pick<DashboardStats, "byModel" | "modelSeries" | "modelPerformanceSeries">> {
	await initDb();
	const { modelSeriesDays, modelPerformanceDays, cutoff } = getTimeRangeConfig(range);

	return {
		byModel: getStatsByModel(cutoff ?? undefined),
		modelSeries: getModelTimeSeries(modelSeriesDays, cutoff),
		modelPerformanceSeries: getModelPerformanceSeries(modelPerformanceDays, cutoff),
	};
}

export async function getCostDashboardStats(range?: string | null): Promise<Pick<DashboardStats, "costSeries">> {
	await initDb();
	const { costSeriesDays, cutoff } = getTimeRangeConfig(range);

	return {
		costSeries: getCostTimeSeries(costSeriesDays, cutoff),
	};
}
export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentRequests(limit);
}

export async function getRecentErrors(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentErrors(limit);
}

export async function getRequestDetails(id: number): Promise<RequestDetails | null> {
	await initDb();
	const msg = getMessageById(id);
	if (!msg) return null;

	const entry = await getSessionEntry(msg.sessionFile, msg.entryId);
	if (!entry || entry.type !== "message") return null;

	// TODO: Get parent/context messages?
	// For now we return the single entry which contains the assistant response.
	// The user prompt is likely the parent.

	return {
		...msg,
		messages: [entry],
		output: (entry as any).message,
	};
}

/**
 * Get the current message count in the database.
 */
export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	return getMessageCount();
}
