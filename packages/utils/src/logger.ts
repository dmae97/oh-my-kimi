/**
 * Centralized file logger for omp.
 *
 * Logs to ~/.omp/logs/ with size-based rotation, supporting concurrent omp instances.
 * Each log entry includes process.pid for traceability.
 */
import * as fs from "node:fs";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { getLogsDir } from "./dirs";

/** Ensure logs directory exists */
function ensureLogsDir(): string {
	const logsDir = getLogsDir();
	if (!fs.existsSync(logsDir)) {
		fs.mkdirSync(logsDir, { recursive: true });
	}
	return logsDir;
}

/** Custom format that includes pid and flattens metadata */
const logFormat = winston.format.combine(
	winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
	winston.format.printf(({ timestamp, level, message, ...meta }) => {
		const entry: Record<string, unknown> = {
			timestamp,
			level,
			pid: process.pid,
			message,
		};
		// Flatten metadata into entry
		for (const [key, value] of Object.entries(meta)) {
			if (key !== "level" && key !== "timestamp" && key !== "message") {
				entry[key] = value;
			}
		}
		return JSON.stringify(entry);
	}),
);

/** Size-based rotating file transport */
const fileTransport = new DailyRotateFile({
	dirname: ensureLogsDir(),
	filename: "omp.%DATE%.log",
	datePattern: "YYYY-MM-DD",
	maxSize: "10m",
	maxFiles: 5,
	zippedArchive: true,
});

/** The winston logger instance */
const winstonLogger = winston.createLogger({
	level: "debug",
	format: logFormat,
	transports: [fileTransport],
	// Don't exit on error - logging failures shouldn't crash the app
	exitOnError: false,
});

/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message: string, context?: Record<string, unknown>): void {
	try {
		winstonLogger.error(message, context);
	} catch {
		// Silently ignore logging failures
	}
}

/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function warn(message: string, context?: Record<string, unknown>): void {
	try {
		winstonLogger.warn(message, context);
	} catch {
		// Silently ignore logging failures
	}
}

/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function debug(message: string, context?: Record<string, unknown>): void {
	try {
		winstonLogger.debug(message, context);
	} catch {
		// Silently ignore logging failures
	}
}

const LOGGED_TIMING_THRESHOLD_MS = 5;

/** Sequential wall-clock markers (next marker closes the previous segment). */
let gTimings: [op: string, ts: number][] = [];

/** Await-accurate durations (safe for parallel work; sums can overlap). */
let gAsyncSpans: [op: string, durationMs: number][] = [];

/** Whether to record timings. */
let gRecordTimings = false;

/**
 * Print collected timings to stderr.
 * Wall segments are gaps between consecutive {@link time} markers only; they are wrong when
 * concurrent code also calls {@link time} (e.g. parallel capability loads). Use {@link timeAsync}
 * for those awaits instead.
 */
export function printTimings(): void {
	if (!gRecordTimings || gTimings.length === 0) {
		console.error("\n--- Startup Timings ---\n(no markers)\n");
		return;
	}

	const endTs = performance.now();
	gTimings.push(["(end)", endTs]);

	console.error("\n--- Startup timings (wall segments between time() markers) ---");
	const firstTs = gTimings[0][1];
	for (let i = 0; i < gTimings.length - 1; i++) {
		const [op, ts] = gTimings[i];
		const [, nextTs] = gTimings[i + 1];
		const dur = nextTs - ts;
		if (dur > LOGGED_TIMING_THRESHOLD_MS) {
			console.error(`  ${op}: ${dur}ms`);
		}
	}
	console.error(`  span (first marker → end): ${endTs - firstTs}ms`);

	if (gAsyncSpans.length > 0) {
		console.error("\n--- Async (await-accurate; parallel spans may overlap) ---");
		for (const [op, dur] of gAsyncSpans) {
			if (dur > LOGGED_TIMING_THRESHOLD_MS) {
				console.error(`  ${op}: ${dur}ms`);
			}
		}
	}

	console.error("------------------------\n");

	gTimings.pop();
}

/**
 * Begin recording startup timings. Seeds the timeline so the first segment is meaningful.
 */
export function startTiming(): void {
	gTimings = [["(startup)", performance.now()]];
	gAsyncSpans = [];
	gRecordTimings = true;
}

/**
 * End timing window and clear buffers.
 */
export function endTiming(): void {
	gTimings = [];
	gAsyncSpans = [];
	gRecordTimings = false;
}

function recordAsyncSpan(op: string, start: number): void {
	const dur = performance.now() - start;
	if (dur > LOGGED_TIMING_THRESHOLD_MS) {
		gAsyncSpans.push([op, dur]);
	}
}

/**
 * Wall-clock segment boundary: duration for this label runs until the next {@link time} call.
 * Do not use across `await` when other tasks may call {@link time}; use {@link timeAsync} for the awaited work.
 */
export function time(op: string): void;
export function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T;
export function time<T, A extends unknown[]>(op: string, fn?: (...args: A) => T, ...args: A): T | undefined {
	if (fn === undefined) {
		if (gRecordTimings) {
			gTimings.push([op, performance.now()]);
		}
		return undefined as T;
	} else if (gRecordTimings) {
		const start = performance.now();
		try {
			const result = fn(...args);
			if (result instanceof Promise) {
				return result.finally(recordAsyncSpan.bind(null, op, start)) as T;
			}
			recordAsyncSpan(op, start);
			return result;
		} catch (error) {
			recordAsyncSpan(op, start);
			throw error;
		}
	} else {
		return fn(...args);
	}
}
