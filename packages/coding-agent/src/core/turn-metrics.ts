/**
 * Per-turn runtime metrics.
 *
 * Before this, `telemetry.ts` covered install opt-in and nothing else, and
 * `run-journal.ts` recorded a hash-chained *integrity* log (run started /
 * finished / tool timeout). Neither could answer the questions that actually
 * drive harness work: which tools fail, how long they take, what a turn costs,
 * and whether the context cache is doing anything.
 *
 * Shape: one JSON object per line under `<cwd>/.omk/metrics/turns.jsonl`.
 * Append-only, bounded by size with a single rotation, and never load-bearing —
 * a failed write is dropped, never surfaced as a turn error.
 *
 * Privacy: records counts, durations, ids, and error *classes*. It never
 * records prompt text, tool arguments, tool output, or file contents. Tool
 * error strings are truncated and kept only to distinguish failure modes.
 */

import fs from "node:fs";
import path from "node:path";
import { parseRuntimeProvenance, type RuntimeProvenance } from "./runtime-provenance.ts";

export const TURN_METRICS_SCHEMA_VERSION = "omk-turn-metrics-1" as const;
/** Rotate once the active file passes this size. */
export const DEFAULT_MAX_METRICS_BYTES = 8 * 1024 * 1024;
/** Cap on a retained error string. Enough to classify, too short to carry a payload. */
export const MAX_ERROR_CHARS = 200;

export interface ToolCallMetric {
	readonly name: string;
	readonly durationMs: number;
	readonly ok: boolean;
	/** Truncated failure text, present only when `ok` is false. */
	readonly error?: string;
}

export interface TurnUsageMetric {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costUsd: number;
}

export interface TurnMetricInput {
	readonly sessionId: string;
	readonly turnIndex: number;
	readonly provider?: string;
	readonly model?: string;
	readonly startedAtEpochMs: number;
	readonly endedAtEpochMs: number;
	/** Time to the first streamed assistant chunk, when observed. */
	readonly timeToFirstChunkMs?: number;
	readonly usage?: TurnUsageMetric;
	readonly stopReason?: string;
	readonly toolCalls?: readonly ToolCallMetric[];
	/** Whether compaction ran during this turn. */
	readonly compacted?: boolean;
	/** Provider failover attempts made during this turn. */
	readonly failovers?: number;
	/** Context-budget cache outcome for the turn's prompt build. */
	readonly contextCache?: { readonly planHit: boolean; readonly hits: number; readonly misses: number };
	/** Requested/selected/response model and thinking projection. Advisory metadata only. */
	readonly runtimeProvenance?: RuntimeProvenance;
}

export interface TurnMetricRecord extends TurnMetricInput {
	readonly schemaVersion: typeof TURN_METRICS_SCHEMA_VERSION;
	readonly durationMs: number;
	readonly toolCallCount: number;
	readonly toolFailureCount: number;
}

function truncateError(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const collapsed = value.replace(/\s+/gu, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length > MAX_ERROR_CHARS ? `${collapsed.slice(0, MAX_ERROR_CHARS)}\u2026` : collapsed;
}

/**
 * Build the record written for one turn. Pure: no clock, no filesystem, so the
 * derived fields can be asserted directly.
 */
export function buildTurnMetricRecord(input: TurnMetricInput): TurnMetricRecord {
	const toolCalls = (input.toolCalls ?? []).map((call) => ({
		name: call.name,
		durationMs: Math.max(0, Math.round(call.durationMs)),
		ok: call.ok,
		...(call.ok ? {} : { error: truncateError(call.error) }),
	}));
	const runtimeProvenance =
		input.runtimeProvenance === undefined ? undefined : parseRuntimeProvenance(input.runtimeProvenance);
	// Spread the raw input minus its projection: a validated projection is re-added
	// below, an invalid one is dropped rather than persisted.
	const { runtimeProvenance: _rawProvenance, ...rest } = input;
	return {
		...rest,
		schemaVersion: TURN_METRICS_SCHEMA_VERSION,
		durationMs: Math.max(0, input.endedAtEpochMs - input.startedAtEpochMs),
		toolCalls,
		toolCallCount: toolCalls.length,
		toolFailureCount: toolCalls.filter((call) => !call.ok).length,
		...(runtimeProvenance === null || runtimeProvenance === undefined ? {} : { runtimeProvenance }),
	};
}

export interface TurnMetricsSinkOptions {
	readonly dir: string;
	readonly maxBytes?: number;
	readonly fileName?: string;
}

/**
 * Append-only JSONL sink. Writes are synchronous and best-effort: metrics must
 * never be the reason a turn fails, so every filesystem error is swallowed and
 * counted instead of thrown.
 */
export class TurnMetricsSink {
	private readonly filePath: string;
	private readonly maxBytes: number;
	private dropped = 0;
	private written = 0;

	constructor(options: TurnMetricsSinkOptions) {
		this.filePath = path.join(options.dir, options.fileName ?? "turns.jsonl");
		this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_METRICS_BYTES);
	}

	get path(): string {
		return this.filePath;
	}

	/** Records written successfully this process. */
	get writtenCount(): number {
		return this.written;
	}

	/** Records lost to a filesystem error this process. */
	get droppedCount(): number {
		return this.dropped;
	}

	/** Append one turn. Returns `true` when the line reached disk. */
	record(input: TurnMetricInput): boolean {
		let line: string;
		try {
			line = `${JSON.stringify(buildTurnMetricRecord(input))}\n`;
		} catch {
			this.dropped++;
			return false;
		}
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
			fs.appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
			this.written++;
			return true;
		} catch {
			this.dropped++;
			return false;
		}
	}

	private rotateIfNeeded(incomingBytes: number): void {
		let size: number;
		try {
			size = fs.statSync(this.filePath).size;
		} catch {
			return; // No file yet.
		}
		if (size + incomingBytes <= this.maxBytes) return;
		try {
			// Single generation: the previous file is replaced, so disk use stays bounded at 2x.
			fs.renameSync(this.filePath, `${this.filePath}.1`);
		} catch {
			// Rotation failure is not fatal; the next append still succeeds.
		}
	}
}

export interface ToolAggregate {
	readonly name: string;
	readonly calls: number;
	readonly failures: number;
	readonly failureRate: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly totalMs: number;
}

export interface TurnMetricsSummary {
	readonly turns: number;
	readonly sessions: number;
	readonly models: readonly string[];
	readonly totalCostUsd: number;
	readonly totals: TurnUsageMetric;
	readonly turnDurationP50Ms: number;
	readonly turnDurationP95Ms: number;
	readonly timeToFirstChunkP50Ms?: number;
	readonly cacheReadShare: number;
	readonly compactions: number;
	readonly failovers: number;
	readonly contextCachePlanHitRate?: number;
	/** Turns where a valid projection's response model differs from the selected model. */
	readonly provenanceMismatchTurns: number;
	readonly tools: readonly ToolAggregate[];
	/** Lines that could not be parsed as a metric record. */
	readonly malformedLines: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): TurnMetricRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.schemaVersion !== TURN_METRICS_SCHEMA_VERSION) return undefined;
	if (typeof parsed.turnIndex !== "number" || typeof parsed.durationMs !== "number") return undefined;
	return parsed as unknown as TurnMetricRecord;
}

/**
 * Aggregate JSONL lines into a summary. Malformed lines are counted rather than
 * discarded silently, so a truncated tail is visible instead of pretending the
 * data is complete.
 */
export function summarizeTurnMetrics(lines: readonly string[]): TurnMetricsSummary {
	const records: TurnMetricRecord[] = [];
	let malformedLines = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const record = parseRecord(trimmed);
		if (record) records.push(record);
		else malformedLines++;
	}

	const sessions = new Set<string>();
	const models = new Set<string>();
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
	const turnDurations: number[] = [];
	const firstChunkTimes: number[] = [];
	const toolStats = new Map<string, { durations: number[]; failures: number }>();
	let compactions = 0;
	let failovers = 0;
	let planHits = 0;
	let planObservations = 0;
	let provenanceMismatchTurns = 0;

	for (const record of records) {
		sessions.add(record.sessionId);
		if (record.model) models.add(record.provider ? `${record.provider}/${record.model}` : record.model);
		if (record.usage) {
			totals.input += record.usage.input;
			totals.output += record.usage.output;
			totals.cacheRead += record.usage.cacheRead;
			totals.cacheWrite += record.usage.cacheWrite;
			totals.costUsd += record.usage.costUsd;
		}
		turnDurations.push(record.durationMs);
		if (typeof record.timeToFirstChunkMs === "number") firstChunkTimes.push(record.timeToFirstChunkMs);
		if (record.compacted) compactions++;
		failovers += record.failovers ?? 0;
		if (record.contextCache) {
			planObservations++;
			if (record.contextCache.planHit) planHits++;
		}
		// Re-validate provenance at read time: a tampered projection never counts.
		const provenance =
			record.runtimeProvenance === undefined ? undefined : parseRuntimeProvenance(record.runtimeProvenance);
		if (
			provenance !== undefined &&
			provenance !== null &&
			provenance.responseModel !== null &&
			provenance.responseModel !== provenance.selectedModel
		) {
			provenanceMismatchTurns++;
		}
		for (const call of record.toolCalls ?? []) {
			const stats = toolStats.get(call.name) ?? { durations: [], failures: 0 };
			stats.durations.push(call.durationMs);
			if (!call.ok) stats.failures++;
			toolStats.set(call.name, stats);
		}
	}

	turnDurations.sort((a, b) => a - b);
	firstChunkTimes.sort((a, b) => a - b);

	const tools: ToolAggregate[] = [...toolStats.entries()]
		.map(([name, stats]) => {
			const sorted = [...stats.durations].sort((a, b) => a - b);
			return {
				name,
				calls: sorted.length,
				failures: stats.failures,
				failureRate: sorted.length === 0 ? 0 : stats.failures / sorted.length,
				p50Ms: percentile(sorted, 0.5),
				p95Ms: percentile(sorted, 0.95),
				totalMs: sorted.reduce((sum, value) => sum + value, 0),
			};
		})
		.sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));

	const promptSideTotal = totals.input + totals.cacheRead;
	return {
		turns: records.length,
		sessions: sessions.size,
		models: [...models].sort(),
		totalCostUsd: totals.costUsd,
		totals,
		turnDurationP50Ms: percentile(turnDurations, 0.5),
		turnDurationP95Ms: percentile(turnDurations, 0.95),
		timeToFirstChunkP50Ms: firstChunkTimes.length > 0 ? percentile(firstChunkTimes, 0.5) : undefined,
		cacheReadShare: promptSideTotal === 0 ? 0 : totals.cacheRead / promptSideTotal,
		compactions,
		failovers,
		contextCachePlanHitRate: planObservations === 0 ? undefined : planHits / planObservations,
		provenanceMismatchTurns,
		tools,
		malformedLines,
	};
}

/** Read and summarize a metrics file. A missing file summarizes as zero turns. */
export function summarizeTurnMetricsFile(filePath: string): TurnMetricsSummary {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return summarizeTurnMetrics([]);
	}
	return summarizeTurnMetrics(raw.split("\n"));
}
