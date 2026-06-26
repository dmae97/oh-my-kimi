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

import * as path from "node:path";
import { getAgentDir, getStatsDbPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getTimeRangeConfig } from "./aggregator";
import type {
	GainDashboardStats,
	GainSourceTotals,
	GainTimeSeriesPoint,
	GainTopFilter,
	GainUnparsedCommand,
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

// Paths that carry no tuning signal — temp/internal locations.
const TEMP_PATH_RE = /\/T\/|\/tmp\/|\/pi-bash-exec|\/omp-bash-exec|\/pi-bash-detach|\/var\/folders\//;

// ---------------------------------------------------------------------------
// Project-match helper
// ---------------------------------------------------------------------------

/**
 * True when `cwd` (or its normalized project root) exactly equals `project`
 * or is a direct sub-path of it.
 *
 * Normalization is applied so that a cwd of `/repo-worktrees/lane/src` matches
 * a project root of `/repo` — the selector shows normalized roots, so the
 * filter must compare apples-to-apples.
 */
function matchesProject(cwd: string | undefined, project: string): boolean {
	if (!cwd) return false;
	const normalized = normalizeProjectPath(cwd) ?? cwd;
	return normalized === project || normalized.startsWith(`${project}/`);
}

// ---------------------------------------------------------------------------
// Minimizer JSONL — single read, three derived result sets
// ---------------------------------------------------------------------------

interface MinimizerSets {
	records: MinimizerRecord[];
	unparsed: MinimizerRecord[];
	projects: Set<string>;
}

async function readMinimizerFile(): Promise<string | null> {
	const filePath = path.join(getAgentDir(), "minimizer-gain.jsonl");
	try {
		return await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) logger.debug("gain-aggregator: failed to read minimizer-gain.jsonl", { err: String(err) });
		return null;
	}
}

/**
 * Parse the minimizer JSONL exactly once and derive all three result sets in
 * a single pass. Avoids re-reading and re-parsing the file three times per
 * dashboard request.
 */
async function readMinimizerSets(cutoff: number | null, project: string | null): Promise<MinimizerSets> {
	const text = await readMinimizerFile();
	const sets: MinimizerSets = { records: [], unparsed: [], projects: new Set() };
	if (!text) return sets;

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as MinimizerRecord;

			// Always collect project cwds (unfiltered).
			if (rec.cwd) sets.projects.add(rec.cwd);

			const ts = new Date(rec.timestamp).getTime();
			if (cutoff !== null && ts < cutoff) continue;
			if (project !== null && !matchesProject(rec.cwd, project)) continue;

			if (rec.kind === "missed") {
				// Unparsed: only "no filter matched" records from meaningful cwds.
				if (rec.filter === "missed" && !TEMP_PATH_RE.test(rec.cwd ?? "")) {
					sets.unparsed.push(rec);
				}
			} else {
				sets.records.push(rec);
			}
		} catch {
			/* skip malformed */
		}
	}
	return sets;
}

// ---------------------------------------------------------------------------
// Project normalization & deduplication
// ---------------------------------------------------------------------------

/**
 * Collapse worktree sub-paths to their logical project root.
 *
 * Rules are generic: omp internal wt paths are dropped; conventional worktree
 * suffixes (`.wt/`, `-wt/`, `.worktrees/`, `-worktrees/`) are stripped. No
 * author-specific IDE or tool paths are baked in.
 *
 * Returns null to drop temp/internal paths entirely.
 */
function normalizeProjectPath(p: string): string | null {
	if (TEMP_PATH_RE.test(p)) return null;
	// omp internal worktrees — not meaningful project roots
	if (/\/\.omp\/wt\//.test(p)) return null;

	// Generic worktree layouts — strip the worktree suffix/subpath.
	// Matches: <root>/.wt/<lane>/..., <root>-wt/<lane>/...,
	//          <root>.wt/<lane>/..., <root>/.worktrees/<lane>/...,
	//          <root>-worktrees/<lane>/..., <root>/.herdr/worktrees/<name>/...
	const m = p.match(/^(.+?)(?:\/\.wt\/|\/\.worktrees\/|-worktrees\/|-wt\/|\.wt\/|\/.+\/worktrees\/)[^/]+(\/.*)?$/);
	if (m) return m[1];

	return p;
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
		// to be a meaningful scope boundary (depth ≥ 4), not a catch-all like /Users/x.
		return !sorted.some(
			other =>
				other !== p &&
				other.length < p.length &&
				p.startsWith(other.endsWith("/") ? other : `${other}/`) &&
				other.split("/").filter(Boolean).length >= 4,
		);
	});
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

/**
 * Snapcompact records carry no cwd/project field — project filter cannot be
 * applied. When a project is selected the snapcompact totals are omitted from
 * project-scoped responses to avoid mixing unrelated savings into the
 * per-project view.
 */
async function readSnapcompactRecords(cutoff: number | null, project: string | null): Promise<SnapcompactRecord[]> {
	// No project field → skip entirely for project-scoped requests.
	if (project !== null) return [];

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
		} catch {
			/* skip malformed line */
		}
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
	const filePath = path.join(getAgentDir(), "pi-distill", "stats.json");
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
		if (project !== null) sessions = sessions.filter(s => matchesProject(s.project, project));
		return sessions;
	} catch (err) {
		logger.debug("gain-aggregator: failed to parse pi-distill stats.json", { err: String(err) });
		return [];
	}
}

/** Collect all distinct project values from pi-distill stats (unfiltered). */
async function readDistillProjects(): Promise<Set<string>> {
	const filePath = path.join(getAgentDir(), "pi-distill", "stats.json");
	const projects = new Set<string>();
	try {
		const raw = await Bun.file(filePath).text();
		const stats = JSON.parse(raw) as PiDistillStats;
		for (const s of Object.values(stats.sessions ?? {})) {
			if (s.project) projects.add(s.project);
		}
	} catch {
		/* ignore */
	}
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
	const { cutoff: effectiveCutoff } = getTimeRangeConfig(range);
	const effectiveProject: string | null = project?.trim() || null;

	const [minimizerSets, snapcompactRecords, distillRecords, distillProjects] = await Promise.all([
		readMinimizerSets(effectiveCutoff, effectiveProject),
		readSnapcompactRecords(effectiveCutoff, effectiveProject),
		readPiDistillRecords(effectiveCutoff, effectiveProject),
		readDistillProjects(),
	]);

	const { records: minimizerRecords, unparsed: unparsedRecords, projects: minimizerProjects } = minimizerSets;

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
	// Key on the full command string to avoid collision; truncate only at display time.
	const cmdMap = new Map<string, GainUnparsedCommand>();
	for (const rec of unparsedRecords) {
		const fullKey = rec.command ?? "";
		const existing = cmdMap.get(fullKey);
		if (existing) {
			existing.hits += 1;
			existing.inputBytes += rec.inputBytes ?? 0;
		} else {
			// Store the full command; callers may truncate for display.
			cmdMap.set(fullKey, { command: fullKey, hits: 1, inputBytes: rec.inputBytes ?? 0 });
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
	// reductionPercent is computed only from sources that have originalBytes
	// (minimizer + distill). Snapcompact has no originalBytes, so including its
	// savedBytes in the numerator with nothing in the denominator would overstate
	// the ratio. The per-source cards each report their own correct ratio.
	const overall: GainSourceTotals = {
		savedTokens: minimizerTotals.savedTokens + snapcompactTotals.savedTokens + distillTotals.savedTokens,
		savedBytes: minimizerTotals.savedBytes + snapcompactTotals.savedBytes + distillTotals.savedBytes,
		hits: minimizerTotals.hits + snapcompactTotals.hits + distillTotals.hits,
		outputBytes: minimizerTotals.outputBytes + distillTotals.outputBytes,
		originalBytes: minimizerTotals.originalBytes + distillTotals.originalBytes,
		reductionPercent: null,
	};
	// Use only sources with originalBytes for the ratio to avoid inflated percentages.
	const ratioNumerator = minimizerTotals.savedBytes + distillTotals.savedBytes;
	const ratioDenominator = overall.originalBytes;
	if (ratioDenominator > 0) {
		overall.reductionPercent = ratioNumerator / ratioDenominator;
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
