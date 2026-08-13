/**
 * `omk stats` — read the per-turn metrics JSONL and print an aggregate.
 *
 * Answers the questions the harness previously had no data for: which tools
 * fail, how long turns take, what they cost, and whether the context cache is
 * doing anything. Read-only; it never starts a session.
 */

import { join, resolve } from "node:path";
import { summarizeTurnMetricsFile, type TurnMetricsSummary } from "../core/turn-metrics.ts";

const USAGE = "Usage: omk stats [--dir <path>] [--json]";

export interface StatsCliOverrides {
	readonly cwd?: string;
	readonly writeLine?: (line: string) => void;
}

export interface StatsCliOutcome {
	readonly handled: boolean;
	readonly exitCode: 0 | 1 | 2;
}

type ParsedArgs =
	| { kind: "absent" }
	| { kind: "help" }
	| { kind: "error"; message: string }
	| { kind: "run"; dir?: string; json: boolean };

function parseArgs(args: readonly string[]): ParsedArgs {
	if (args[0] !== "stats") return { kind: "absent" };
	let dir: string | undefined;
	let json = false;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--dir") {
			const value = args[++index];
			if (value === undefined) return { kind: "error", message: "--dir requires a path" };
			dir = value;
			continue;
		}
		return { kind: "error", message: `unknown argument: ${arg}` };
	}
	return { kind: "run", dir, json };
}

function formatMs(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
	return `${Math.round(value)}ms`;
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

/** Render the human-readable report. Pure, so its shape is directly testable. */
export function renderStatsReport(summary: TurnMetricsSummary, filePath: string): string[] {
	if (summary.turns === 0) {
		return [
			`No turn metrics recorded yet (${filePath}).`,
			"Metrics are written as sessions run. Set OMK_TURN_METRICS=0 to disable.",
		];
	}

	const lines = [
		`Turn metrics — ${formatCount(summary.turns)} turns across ${formatCount(summary.sessions)} session(s)`,
		`  models        ${summary.models.length > 0 ? summary.models.join(", ") : "unknown"}`,
		`  turn duration p50 ${formatMs(summary.turnDurationP50Ms)} · p95 ${formatMs(summary.turnDurationP95Ms)}`,
	];
	if (summary.timeToFirstChunkP50Ms !== undefined) {
		lines.push(`  first chunk   p50 ${formatMs(summary.timeToFirstChunkP50Ms)}`);
	}
	lines.push(
		`  input ${formatCount(summary.totals.input)} · output ${formatCount(summary.totals.output)} · cacheRead ${formatCount(summary.totals.cacheRead)} · cacheWrite ${formatCount(summary.totals.cacheWrite)}`,
		`  cache read share ${formatPercent(summary.cacheReadShare)} of prompt-side usage`,
		`  cost          $${summary.totalCostUsd.toFixed(4)}`,
		`  compactions ${formatCount(summary.compactions)} · failovers ${formatCount(summary.failovers)} · ctx plan hit ${formatPercent(summary.contextCachePlanHitRate)}`,
	);

	if (summary.tools.length > 0) {
		lines.push("", "  tool                 calls   fail%     p50     p95    total");
		for (const tool of summary.tools.slice(0, 20)) {
			lines.push(
				`  ${tool.name.padEnd(20).slice(0, 20)} ${String(tool.calls).padStart(5)} ${formatPercent(tool.failureRate).padStart(7)} ${formatMs(tool.p50Ms).padStart(7)} ${formatMs(tool.p95Ms).padStart(7)} ${formatMs(tool.totalMs).padStart(8)}`,
			);
		}
	}

	if (summary.malformedLines > 0) {
		lines.push("", `  ${formatCount(summary.malformedLines)} unparseable line(s) skipped`);
	}
	return lines;
}

export function runStatsCli(args: readonly string[], overrides: StatsCliOverrides = {}): StatsCliOutcome {
	const parsed = parseArgs(args);
	if (parsed.kind === "absent") return { handled: false, exitCode: 0 };
	const writeLine = overrides.writeLine ?? ((line: string) => console.log(line));
	if (parsed.kind === "help") {
		writeLine(USAGE);
		return { handled: true, exitCode: 0 };
	}
	if (parsed.kind === "error") {
		writeLine(JSON.stringify({ status: "refused", error: parsed.message, usage: USAGE }));
		return { handled: true, exitCode: 2 };
	}

	const cwd = resolve(overrides.cwd ?? process.cwd());
	const dir = parsed.dir ?? process.env.OMK_TURN_METRICS_DIR ?? join(cwd, ".omk", "metrics");
	const filePath = join(resolve(dir), "turns.jsonl");
	const summary = summarizeTurnMetricsFile(filePath);

	if (parsed.json) {
		writeLine(JSON.stringify({ status: "ok", path: filePath, summary }));
		return { handled: true, exitCode: 0 };
	}
	for (const line of renderStatsReport(summary, filePath)) writeLine(line);
	return { handled: true, exitCode: 0 };
}
