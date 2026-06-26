/**
 * Aggregates token-savings data from three independent gain-tracking subsystems
 * into a unified GainDashboardStats payload.
 *
 * Sources:
 *   1. Bash minimizer: ~/.omp/agent/minimizer-gain.jsonl
 *   2. Snapcompact:    colocated with stats.db as snapcompact-savings.jsonl
 *   3. Pi-distill:     ~/.omp/agent/pi-distill/stats.json
 *
 * Missing files are treated as zero records — never an error.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getStatsDbPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type {
	GainDashboardStats,
	GainUnparsedCommand,
	GainSourceTotals,
	GainTimeSeriesPoint,
	GainTopFilter,
} from "./shared-types";

const BYTES_PER_TOKEN_ESTIMATE = 4;

// ---------------------------------------------------------------------------
// Minimizer record schema
// ---------------------------------------------------------------------------

interface MinimizerRecord {
	timestamp: string; // ISO
	filter: string;
	command?: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	kind: "saved" | "missed";
	sessionId?: string;
	cwd: string;
}

// Structural skip filters — these mean the parser didn't attempt compression, not a coverage gap.
const SKIP_FILTERS = new Set(["missed", "compound", "chain-noop", "unsupported"]);


async function readMinimizerFile(): Promise<string | null> {
	const filePath = path.join(getAgentDir(), "minimizer-gain.jsonl");
	try {
		return await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) logger.debug("gain-aggregator: failed to read minimizer-gain.jsonl", { err: String(err) });
		return null;
	}
}

async function readMinimizerRecords(cutoff: number | null, project: string | null): Promise<MinimizerRecord[]> {
	const text = await readMinimizerFile();
	if (!text) return [];
	const records: MinimizerRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as MinimizerRecord;
			if (rec.kind === "missed") continue;
			const ts = new Date(rec.timestamp).getTime();
			if (cutoff !== null && ts < cutoff) continue;
			if (project !== null && !rec.cwd?.startsWith(project)) continue;
			records.push(rec);
		} catch { /* skip malformed */ }
	}
	return records;
}

/** Records where NO filter matched (filter==="missed", kind==="missed"), excluding temp/internal paths. */
async function readMinimizerUnparsedRecords(cutoff: number | null, project: string | null): Promise<MinimizerRecord[]> {
	const text = await readMinimizerFile();
	if (!text) return [];
	const records: MinimizerRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as MinimizerRecord;
			// Only "no filter matched" records
			if (rec.kind !== "missed" || rec.filter !== "missed") continue;
			// Skip internal/temp cwds (no tuning signal)
			if (TEMP_PATH_RE.test(rec.cwd ?? "")) continue;
			const ts = new Date(rec.timestamp).getTime();
			if (cutoff !== null && ts < cutoff) continue;
			if (project !== null && !rec.cwd?.startsWith(project)) continue;
			records.push(rec);
		} catch { /* skip malformed */ }
	}
	return records;
}

// ---------------------------------------------------------------------------
// Project normalization & deduplication
// ---------------------------------------------------------------------------

const TEMP_PATH_RE = /\/T\/|\/tmp\/|\/pi-bash-exec|\/omp-bash-exec|\/pi-bash-detach|\/var\/folders\//;

/** Collapse worktree/ephemeral sub-paths to their logical project root. Returns null to drop. */
function normalizeProjectPath(p: string): string | null {
	if (TEMP_PATH_RE.test(p)) return null;
	// omp internal worktrees — not meaningful
	if (/\/\.omp\/wt\//.test(p)) return null;
	// herdr worktrees → /.herdr/worktrees/<project>
	const herdr = p.match(/(\/\.herdr\/worktrees\/[^/]+)/);
	if (herdr) return herdr[1];
	// <prefix>/PycharmProjects/<proj>-factory-worktrees/... → <prefix>/PycharmProjects/<proj>
	const factory = p.match(/(\/PycharmProjects\/[^/]+)-factory-worktrees\/.*/);
	if (factory) return p.slice(0, factory.index!) + factory[1];
	// <prefix>/PycharmProjects/<proj>-worktrees/... → <prefix>/PycharmProjects/<proj>
	const wt = p.match(/(\/PycharmProjects\/[^/]+)-worktrees\/.*/);
	if (wt) return p.slice(0, wt.index!) + wt[1];
	// <prefix>/PycharmProjects/<proj>.wt/<lane>/... → <prefix>/PycharmProjects/<proj>
	const dotWt = p.match(/(\/PycharmProjects\/[^/]+)\.wt\/.*/);
	if (dotWt) return p.slice(0, dotWt.index!) + dotWt[1];
	// <prefix>/PycharmProjects/<proj>-wt/<lane>/... → <prefix>/PycharmProjects/<proj>
	const dashWt = p.match(/(\/PycharmProjects\/[^/]+)-wt\/.*/);
	if (dashWt) return p.slice(0, dashWt.index!) + dashWt[1];
	// PycharmProjects/.worktrees/<proj>/<lane>/... → PycharmProjects/<proj>
	const hiddenWt = p.match(/^(.+\/PycharmProjects)\/\.worktrees\/([^/]+)\/[^/]+.*/);
	if (hiddenWt) return `${hiddenWt[1]}/${hiddenWt[2]}`;
	return p;
}

function pathDepth(p: string): number {
	return p.split("/").filter(Boolean).length;
}

/**
 * Given a raw set of paths, normalize worktree paths and remove sub-paths
 * that are already covered by a shorter parent at depth ≥ 4.
 * Returns a sorted, deduped list of meaningful project roots.
 */
function dedupeProjects(rawPaths: Set<string>): string[] {
	const normalized = new Set<string>();
	for (const p of rawPaths) {
		const n = normalizeProjectPath(p);
		if (n) normalized.add(n);
	}
	const sorted = Array.from(normalized).sort();
	return sorted.filter(p => {
		// Drop p if a shorter path is a proper prefix of it AND that parent is deep enough
		// to be a meaningful scope boundary (depth ≥ 4), not a catch-all like /Users/davidandrews.
		return !sorted.some(
			other =>
				other !== p &&
				other.length < p.length &&
				p.startsWith(other.endsWith("/") ? other : other + "/") &&
				pathDepth(other) >= 4,
		);
	});
}

async function readMinimizerProjects(): Promise<Set<string>> {
	const text = await readMinimizerFile();
	const projects = new Set<string>();
	if (!text) return projects;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as MinimizerRecord;
			if (rec.cwd) projects.add(rec.cwd);
		} catch { /* skip */ }
	}
	return projects;
}



// ---------------------------------------------------------------------------
// Snapcompact record schema
// ---------------------------------------------------------------------------

interface SnapcompactRecord {
	ts: number; // epoch ms
	session: string;
	provider: string;
	model: string;
	toolCallId: string;
	savedTokens: number;
}

async function readSnapcompactRecords(cutoff: number | null, _project: string | null): Promise<SnapcompactRecord[]> {
	// Snapcompact records have no cwd/project field — project filter not applicable.
	const filePath = path.join(path.dirname(getStatsDbPath()), "snapcompact-savings.jsonl");
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.debug("gain-aggregator: failed to read snapcompact-savings.jsonl", { err: String(err) });
		return [];
	}
	const seen = new Set<string>();
	const records: SnapcompactRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as SnapcompactRecord;
			if (cutoff !== null && rec.ts < cutoff) continue;
			const key = `${rec.session}:${rec.toolCallId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			records.push(rec);
		} catch { /* skip malformed line */ }
	}
	return records;
}

// ---------------------------------------------------------------------------
// Pi-distill stats schema (minimal local redeclaration — do not import from pi-distill)
// ---------------------------------------------------------------------------

interface PiDistillSessionRecord {
	sessionId: string;
	project?: string;
	label?: string;
	savedBytes: number;
	hits: number;
	originalBytes?: number;
	replacementBytes?: number;
	firstTs: number;
	lastTs: number;
}

interface PiDistillStats {
	sessions: Record<string, PiDistillSessionRecord>;
}

async function readPiDistillRecords(cutoff: number | null, project: string | null): Promise<PiDistillSessionRecord[]> {
	const filePath = path.join(os.homedir(), ".omp", "agent", "pi-distill", "stats.json");
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.debug("gain-aggregator: failed to read pi-distill stats.json", { err: String(err) });
		return [];
	}
	try {
		const stats = JSON.parse(raw) as PiDistillStats;
		let sessions = Object.values(stats.sessions ?? {});
		if (cutoff !== null) sessions = sessions.filter(s => s.lastTs >= cutoff);
		if (project !== null) sessions = sessions.filter(s => s.project?.startsWith(project));
		return sessions;
	} catch (err) {
		logger.debug("gain-aggregator: failed to parse pi-distill stats.json", { err: String(err) });
		return [];
	}
}

/** Collect all distinct project values from pi-distill stats (unfiltered). */
async function readDistillProjects(): Promise<Set<string>> {
	const filePath = path.join(os.homedir(), ".omp", "agent", "pi-distill", "stats.json");
	const projects = new Set<string>();
	try {
		const raw = await Bun.file(filePath).text();
		const stats = JSON.parse(raw) as PiDistillStats;
		for (const s of Object.values(stats.sessions ?? {})) {
			if (s.project) projects.add(s.project);
		}
	} catch { /* ignore */ }
	return projects;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function emptyTotals(): GainSourceTotals {
	return {
		savedTokens: 0,
		savedBytes: 0,
		hits: 0,
		outputBytes: 0,
		originalBytes: 0,
		reductionPercent: null,
	};
}

function finalizeReductionPercent(totals: GainSourceTotals): GainSourceTotals {
	if (totals.originalBytes > 0) {
		totals.reductionPercent = totals.savedBytes / totals.originalBytes;
	}
	return totals;
}

/** ISO date string from epoch ms, bucketed to the day. */
function toDateBucket(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Main aggregation function
// ---------------------------------------------------------------------------

export async function getGainDashboardStats(
	range?: string | null,
	project?: string | null,
): Promise<GainDashboardStats> {
	const normalized = range?.trim().toLowerCase() ?? "24h";
	const RANGE_MS: Record<string, number> = { "1h": 3600_000, "24h": 86400_000, "7d": 604800_000, "30d": 2592000_000, "90d": 7776000_000 };
	const effectiveCutoff: number | null =
		normalized === "all" ? null : Date.now() - (RANGE_MS[normalized] ?? 86400_000);
	const effectiveProject: string | null = project?.trim() || null;

	const [minimizerRecords, unparsedRecords, snapcompactRecords, distillRecords, minimizerProjects, distillProjects] =
		await Promise.all([
			readMinimizerRecords(effectiveCutoff, effectiveProject),
			readMinimizerUnparsedRecords(effectiveCutoff, effectiveProject),
			readSnapcompactRecords(effectiveCutoff, effectiveProject),
			readPiDistillRecords(effectiveCutoff, effectiveProject),
			readMinimizerProjects(),
			readDistillProjects(),
		]);

	// --- Minimizer totals ---
	const minimizerTotals = emptyTotals();
	const filterMap = new Map<string, GainTopFilter>();
	const timeMap = new Map<string, { minimizer: number; snapcompact: number; distill: number }>();

	for (const rec of minimizerRecords) {
		const tokens = rec.savedTokens ?? Math.floor((rec.savedBytes ?? 0) / BYTES_PER_TOKEN_ESTIMATE);
		const savedBytes = rec.savedBytes ?? 0;
		const inputBytes = rec.inputBytes ?? 0;

		minimizerTotals.savedTokens += tokens;
		minimizerTotals.savedBytes += savedBytes;
		minimizerTotals.hits += 1;
		minimizerTotals.originalBytes += inputBytes;
		minimizerTotals.outputBytes += rec.outputBytes ?? 0;

		// top filters
		const existing = filterMap.get(rec.filter);
		if (existing) {
			existing.savedTokens += tokens;
			existing.savedBytes += savedBytes;
			existing.hits += 1;
		} else {
			filterMap.set(rec.filter, { filter: rec.filter, savedTokens: tokens, savedBytes, hits: 1 });
		}

		// time series
		const ts = new Date(rec.timestamp).getTime();
		const date = toDateBucket(ts);
		const bucket = timeMap.get(date) ?? { minimizer: 0, snapcompact: 0, distill: 0 };
		bucket.minimizer += tokens;
		timeMap.set(date, bucket);
	}
	finalizeReductionPercent(minimizerTotals);

	// --- Unparsed commands (no filter matched — tuning targets) ---
	const cmdMap = new Map<string, GainUnparsedCommand>();
	for (const rec of unparsedRecords) {
		const key = (rec.command ?? "").slice(0, 120);
		const existing = cmdMap.get(key);
		if (existing) {
			existing.hits += 1;
			existing.inputBytes += rec.inputBytes ?? 0;
		} else {
			cmdMap.set(key, { command: key, hits: 1, inputBytes: rec.inputBytes ?? 0 });
		}
	}
	const unparsedCommands: GainUnparsedCommand[] = Array.from(cmdMap.values())
		.sort((a, b) => b.hits - a.hits)
		.slice(0, 25);


	// --- Snapcompact totals ---
	const snapcompactTotals = emptyTotals();

	for (const rec of snapcompactRecords) {
		snapcompactTotals.savedTokens += rec.savedTokens;
		const approxBytes = rec.savedTokens * BYTES_PER_TOKEN_ESTIMATE;
		snapcompactTotals.savedBytes += approxBytes;
		snapcompactTotals.hits += 1;

		const date = toDateBucket(rec.ts);
		const bucket = timeMap.get(date) ?? { minimizer: 0, snapcompact: 0, distill: 0 };
		bucket.snapcompact += rec.savedTokens;
		timeMap.set(date, bucket);
	}
	// No originalBytes for snapcompact — reductionPercent stays null

	// --- Pi-distill totals ---
	const distillTotals = emptyTotals();

	for (const rec of distillRecords) {
		const tokens = Math.floor(rec.savedBytes / BYTES_PER_TOKEN_ESTIMATE);
		distillTotals.savedTokens += tokens;
		distillTotals.savedBytes += rec.savedBytes;
		distillTotals.hits += rec.hits;
		if (rec.originalBytes !== undefined) {
			distillTotals.originalBytes += rec.originalBytes;
			distillTotals.outputBytes += rec.originalBytes - rec.savedBytes;
		}

		const ts = Math.floor((rec.firstTs + rec.lastTs) / 2);
		const date = toDateBucket(ts);
		const bucket = timeMap.get(date) ?? { minimizer: 0, snapcompact: 0, distill: 0 };
		bucket.distill += tokens;
		timeMap.set(date, bucket);
	}
	finalizeReductionPercent(distillTotals);

	// --- Overall totals ---
	const overall: GainSourceTotals = {
		savedTokens: minimizerTotals.savedTokens + snapcompactTotals.savedTokens + distillTotals.savedTokens,
		savedBytes: minimizerTotals.savedBytes + snapcompactTotals.savedBytes + distillTotals.savedBytes,
		hits: minimizerTotals.hits + snapcompactTotals.hits + distillTotals.hits,
		outputBytes: minimizerTotals.outputBytes + distillTotals.outputBytes,
		originalBytes: minimizerTotals.originalBytes + distillTotals.originalBytes,
		reductionPercent: null,
	};
	if (overall.originalBytes > 0) {
		overall.reductionPercent = overall.savedBytes / overall.originalBytes;
	}

	// --- Time series (sorted ascending by date) ---
	const timeSeries: GainTimeSeriesPoint[] = Array.from(timeMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, bucket]) => ({
			date,
			minimizer: bucket.minimizer,
			snapcompact: bucket.snapcompact,
			distill: bucket.distill,
			total: bucket.minimizer + bucket.snapcompact + bucket.distill,
		}));

	// --- Top filters (top 10 by savedTokens) ---
	const topFilters: GainTopFilter[] = Array.from(filterMap.values())
		.sort((a, b) => b.savedTokens - a.savedTokens)
		.slice(0, 10);

	// --- Projects list (union of minimizer cwds + distill projects, normalized & deduped) ---
	const allProjects = new Set<string>([...minimizerProjects, ...distillProjects]);
	const projects = dedupeProjects(allProjects);

	return {
		overall,
		bySource: {
			minimizer: minimizerTotals,
			snapcompact: snapcompactTotals,
			distill: distillTotals,
		},
		timeSeries,
		topFilters,
		unparsedCommands,
		project: effectiveProject,
		projects,
	};
}
