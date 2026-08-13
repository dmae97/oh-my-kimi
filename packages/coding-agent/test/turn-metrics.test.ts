import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStatsReport, runStatsCli } from "../src/commands/stats-cli.ts";
import { buildRuntimeProvenance } from "../src/core/runtime-provenance.ts";
import {
	buildTurnMetricRecord,
	MAX_ERROR_CHARS,
	summarizeTurnMetrics,
	summarizeTurnMetricsFile,
	TURN_METRICS_SCHEMA_VERSION,
	type TurnMetricInput,
	TurnMetricsSink,
} from "../src/core/turn-metrics.ts";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-turn-metrics-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function turn(overrides: Partial<TurnMetricInput> = {}): TurnMetricInput {
	return {
		sessionId: "session-a",
		turnIndex: 0,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		startedAtEpochMs: 1_000,
		endedAtEpochMs: 3_500,
		usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 10, costUsd: 0.0125 },
		stopReason: "stop",
		toolCalls: [{ name: "bash", durationMs: 120, ok: true }],
		...overrides,
	};
}

describe("turn metric records", () => {
	it("derives duration and tool counters", () => {
		const record = buildTurnMetricRecord(
			turn({
				toolCalls: [
					{ name: "read", durationMs: 10, ok: true },
					{ name: "bash", durationMs: 40, ok: false, error: "exit 1" },
				],
			}),
		);
		expect(record.durationMs).toBe(2500);
		expect(record.toolCallCount).toBe(2);
		expect(record.toolFailureCount).toBe(1);
		expect(record.schemaVersion).toBe(TURN_METRICS_SCHEMA_VERSION);
	});

	it("clamps a negative duration rather than emitting nonsense", () => {
		expect(buildTurnMetricRecord(turn({ startedAtEpochMs: 5_000, endedAtEpochMs: 1_000 })).durationMs).toBe(0);
	});

	it("preserves a valid runtime provenance projection on the record", () => {
		const runtimeProvenance = buildRuntimeProvenance({
			requestedModel: "anthropic/claude-opus-5",
			selectedModel: "openai/gpt-5.6-sol",
			responseModel: "openai/gpt-5.6-sol",
			requestedThinking: "auto",
			effectiveThinking: "max",
			source: "session",
			observedAt: "2026-08-13T05:00:00.000Z",
		});
		const record = buildTurnMetricRecord(turn({ runtimeProvenance }));
		expect(record.runtimeProvenance?.requestedModel).toBe("anthropic/claude-opus-5");
		expect(record.runtimeProvenance?.selectedModel).toBe("openai/gpt-5.6-sol");
		expect(record.runtimeProvenance?.requestedThinking).toBe("auto");
	});

	it("drops an invalid provenance projection instead of persisting it", () => {
		const forged = { ...buildRuntimeProvenance({}), extra: 1 };
		const record = buildTurnMetricRecord(turn({ runtimeProvenance: forged as never }));
		expect(record.runtimeProvenance).toBeUndefined();
	});

	it("keeps error text only on failures, collapsed and truncated", () => {
		const record = buildTurnMetricRecord(
			turn({
				toolCalls: [
					{ name: "ok", durationMs: 1, ok: true, error: "should be dropped" },
					{ name: "bad", durationMs: 1, ok: false, error: `line1\n   line2 ${"x".repeat(500)}` },
				],
			}),
		);
		expect(record.toolCalls?.[0]).not.toHaveProperty("error");
		const error = record.toolCalls?.[1].error ?? "";
		expect(error.startsWith("line1 line2")).toBe(true);
		expect(error.length).toBe(MAX_ERROR_CHARS + 1); // includes the ellipsis
	});

	it("records no prompt, argument, or output text", () => {
		const serialized = JSON.stringify(buildTurnMetricRecord(turn()));
		expect(serialized).not.toContain("prompt");
		expect(serialized).not.toContain("arguments");
		expect(serialized).not.toContain("content");
	});
});

describe("turn metrics sink", () => {
	it("appends one JSON line per turn", () => {
		const sink = new TurnMetricsSink({ dir });
		expect(sink.record(turn({ turnIndex: 0 }))).toBe(true);
		expect(sink.record(turn({ turnIndex: 1 }))).toBe(true);

		const lines = fs.readFileSync(sink.path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).turnIndex).toBe(1);
		expect(sink.writtenCount).toBe(2);
		expect(sink.droppedCount).toBe(0);
	});

	it("rotates once past maxBytes and keeps exactly one generation", () => {
		const sink = new TurnMetricsSink({ dir, maxBytes: 1024 });
		for (let index = 0; index < 12; index++) sink.record(turn({ turnIndex: index }));

		expect(fs.existsSync(`${sink.path}.1`)).toBe(true);
		expect(fs.readdirSync(dir).sort()).toEqual(["turns.jsonl", "turns.jsonl.1"]);
	});

	it("drops instead of throwing when the directory is unusable", () => {
		const blocked = path.join(dir, "blocked");
		fs.writeFileSync(blocked, "i am a file", "utf8");
		const sink = new TurnMetricsSink({ dir: blocked });
		expect(sink.record(turn())).toBe(false);
		expect(sink.droppedCount).toBe(1);
	});
});

describe("turn metrics summary", () => {
	const lines = (records: TurnMetricInput[]) => records.map((record) => JSON.stringify(buildTurnMetricRecord(record)));

	it("aggregates usage, cost, and cache share", () => {
		const summary = summarizeTurnMetrics(
			lines([
				turn({ turnIndex: 0 }),
				turn({ turnIndex: 1, usage: { input: 100, output: 30, cacheRead: 100, cacheWrite: 0, costUsd: 0.01 } }),
			]),
		);
		expect(summary.turns).toBe(2);
		expect(summary.sessions).toBe(1);
		expect(summary.models).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(summary.totals.output).toBe(50);
		expect(summary.totalCostUsd).toBeCloseTo(0.0225, 6);
		// cacheRead 1000 of (input 200 + cacheRead 1000)
		expect(summary.cacheReadShare).toBeCloseTo(1000 / 1200, 6);
	});

	it("computes per-tool failure rate and latency percentiles", () => {
		const summary = summarizeTurnMetrics(
			lines([
				turn({
					toolCalls: [
						{ name: "bash", durationMs: 10, ok: true },
						{ name: "bash", durationMs: 100, ok: false, error: "boom" },
						{ name: "read", durationMs: 5, ok: true },
					],
				}),
			]),
		);
		const bash = summary.tools.find((tool) => tool.name === "bash");
		expect(bash).toMatchObject({ calls: 2, failures: 1, failureRate: 0.5, totalMs: 110 });
		expect(bash?.p95Ms).toBe(100);
		// Ranked by total time spent, so the expensive tool leads.
		expect(summary.tools[0].name).toBe("bash");
	});

	it("counts malformed lines instead of hiding a truncated tail", () => {
		const summary = summarizeTurnMetrics([
			...lines([turn()]),
			"{not json",
			JSON.stringify({ schemaVersion: "other-version", turnIndex: 0, durationMs: 1 }),
			"",
		]);
		expect(summary.turns).toBe(1);
		expect(summary.malformedLines).toBe(2);
	});

	it("reports cache and resilience counters", () => {
		const summary = summarizeTurnMetrics(
			lines([
				turn({ compacted: true, failovers: 1, contextCache: { planHit: true, hits: 3, misses: 1 } }),
				turn({ turnIndex: 1, contextCache: { planHit: false, hits: 0, misses: 5 } }),
			]),
		);
		expect(summary.compactions).toBe(1);
		expect(summary.failovers).toBe(1);
		expect(summary.contextCachePlanHitRate).toBe(0.5);
	});

	it("summarizes a missing file as zero turns", () => {
		expect(summarizeTurnMetricsFile(path.join(dir, "nope.jsonl")).turns).toBe(0);
	});
});

describe("runtime provenance metrics", () => {
	function provenance(selected: string, response: string | null, observedAt = "2026-08-13T05:00:00.000Z") {
		return buildRuntimeProvenance({
			requestedModel: "anthropic/claude-opus-5",
			selectedModel: selected,
			responseModel: response,
			requestedThinking: "max",
			effectiveThinking: "max",
			source: "session",
			observedAt,
		});
	}

	it("counts only turns where a valid response model differs from the selected model", () => {
		const summary = summarizeTurnMetrics([
			JSON.stringify(
				buildTurnMetricRecord(
					turn({
						turnIndex: 0,
						runtimeProvenance: provenance("anthropic/claude-opus-5", "anthropic/claude-opus-5"),
					}),
				),
			),
			JSON.stringify(
				buildTurnMetricRecord(
					turn({ turnIndex: 1, runtimeProvenance: provenance("anthropic/claude-opus-5", "openai/gpt-5.6-sol") }),
				),
			),
			JSON.stringify(buildTurnMetricRecord(turn({ turnIndex: 2 }))),
		]);
		expect(summary.provenanceMismatchTurns).toBe(1);
	});

	it("ignores a tampered projection when counting mismatches", () => {
		const valid = buildTurnMetricRecord(turn({ turnIndex: 0, runtimeProvenance: provenance("a/b", "a/b") }));
		const line = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
		(line.runtimeProvenance as Record<string, unknown>).responseModel = "sk-ant-abc123def456ghi789";
		const summary = summarizeTurnMetrics([JSON.stringify(line)]);
		expect(summary.provenanceMismatchTurns).toBe(0);
	});
});

describe("omk stats CLI", () => {
	it("ignores unrelated argv", () => {
		expect(runStatsCli(["session", "doctor"])).toEqual({ handled: false, exitCode: 0 });
	});

	it("prints guidance when nothing has been recorded", () => {
		const out: string[] = [];
		const result = runStatsCli(["stats", "--dir", dir], { writeLine: (line) => out.push(line) });
		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(out.join("\n")).toMatch(/No turn metrics recorded yet/u);
	});

	it("renders a report from recorded turns", () => {
		const sink = new TurnMetricsSink({ dir });
		sink.record(turn({ toolCalls: [{ name: "bash", durationMs: 50, ok: false, error: "exit 1" }] }));

		const out: string[] = [];
		runStatsCli(["stats", "--dir", dir], { writeLine: (line) => out.push(line) });
		const text = out.join("\n");
		expect(text).toMatch(/1 turns across 1 session/u);
		expect(text).toMatch(/anthropic\/claude-sonnet-4-5/u);
		expect(text).toMatch(/bash/u);
		expect(text).toMatch(/100\.0%/u); // 1/1 failed
	});

	it("emits machine-readable JSON on --json", () => {
		const sink = new TurnMetricsSink({ dir });
		sink.record(turn());
		const out: string[] = [];
		runStatsCli(["stats", "--dir", dir, "--json"], { writeLine: (line) => out.push(line) });
		const payload = JSON.parse(out[0]);
		expect(payload.status).toBe("ok");
		expect(payload.summary.turns).toBe(1);
	});

	it("refuses unknown arguments with exit code 2", () => {
		const out: string[] = [];
		expect(runStatsCli(["stats", "--nope"], { writeLine: (line) => out.push(line) })).toEqual({
			handled: true,
			exitCode: 2,
		});
		expect(JSON.parse(out[0]).status).toBe("refused");
	});

	it("renders a stable header for an empty summary", () => {
		expect(renderStatsReport(summarizeTurnMetrics([]), "/tmp/x.jsonl")[0]).toMatch(/No turn metrics/u);
	});
});
