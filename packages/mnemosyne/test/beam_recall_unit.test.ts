import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { factRecall, formatContext, recall, recallEnhanced } from "../src/core/beam/recall";
import { initBeam } from "../src/core/beam/schema";
import type { BeamMemoryState } from "../src/core/beam/types";

type TestBeam = BeamMemoryState & { close(): void };

const beams: TestBeam[] = [];

function makeBeam(): TestBeam {
	const db = new Database(":memory:");
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "s1",
		authorId: null,
		authorType: null,
		channelId: "s1",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
		},
		close() {
			db.close();
		},
	};
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

function insertWorking(
	beam: TestBeam,
	id: string,
	content: string,
	options: { timestamp?: string; importance?: number } = {},
): void {
	beam.db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', ?, ?, ?, 'global', 'unknown', 'general')",
		[id, content, options.timestamp ?? "2026-05-30T12:00:00.000Z", beam.sessionId, options.importance ?? 0.5],
	);
}

function insertEpisodic(
	beam: TestBeam,
	id: string,
	content: string,
	options: { timestamp?: string; importance?: number; eventDate?: string } = {},
): void {
	beam.db.run(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type, event_date) VALUES (?, ?, 'test', ?, ?, ?, 'global', 'unknown', 'general', ?)",
		[
			id,
			content,
			options.timestamp ?? "2026-05-30T12:00:00.000Z",
			beam.sessionId,
			options.importance ?? 0.5,
			options.eventDate ?? null,
		],
	);
}

describe("beam recall free functions", () => {
	it("orders deterministic FTS-only working-memory hits by lexical strength", () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-weak", "banana appears once beside unrelated notes");
		insertWorking(beam, "wm-strong", "banana banana banana release checklist");

		const results = recall(beam, "banana", 2, { queryTime: "2026-05-30T12:00:00.000Z" });

		const top = results[0];
		expect(results.map(result => result.id)).toEqual(["wm-strong", "wm-weak"]);
		expect(top?.tier_label).toBe("working");
		if (top === undefined || top.fts_score === undefined) {
			throw new Error("expected a scored recall result");
		}
		expect(top.fts_score).toBeGreaterThan(0);
	});

	it("fuses working and episodic memory candidates", () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-deploy", "deploy runbook says use the blue pipeline");
		insertEpisodic(beam, "em-deploy", "deploy retrospective: blue pipeline avoided downtime");

		const results = recall(beam, "deploy blue pipeline", 5, {
			queryTime: "2026-05-30T12:00:00.000Z",
		});

		expect(results.map(result => result.id)).toContain("wm-deploy");
		expect(results.map(result => result.id)).toContain("em-deploy");
		expect(new Set(results.map(result => result.tier_label))).toEqual(new Set(["working", "episodic"]));
	});

	it("boosts memories near the requested temporal target", () => {
		const beam = makeBeam();
		insertEpisodic(beam, "em-old", "incident alpha resolved by rotating credentials", {
			timestamp: "2026-05-10T09:00:00.000Z",
			eventDate: "2026-05-10",
		});
		insertEpisodic(beam, "em-target", "incident alpha resolved by rotating credentials", {
			timestamp: "2026-05-29T09:00:00.000Z",
			eventDate: "2026-05-29",
		});

		const results = recall(beam, "incident alpha", 2, {
			queryTime: "2026-05-29T12:00:00.000Z",
			temporalWeight: 1.0,
			temporalHalflife: 12,
			includeWorking: false,
		});

		const target = results[0];
		const old = results[1];
		expect(target?.id).toBe("em-target");
		if (
			target === undefined ||
			old === undefined ||
			target.temporal_score === undefined ||
			old.temporal_score === undefined
		) {
			throw new Error("expected two temporally scored recall results");
		}
		expect(target.temporal_score).toBeGreaterThan(old.temporal_score);
	});

	it("accounts for importance and recency in deterministic fallback scoring", () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-low", "phoenix migration requires operator approval", {
			timestamp: new Date().toISOString(),
			importance: 0.1,
		});
		insertWorking(beam, "wm-high", "phoenix migration requires operator approval", {
			timestamp: "2025-05-30T12:00:00.000Z",
			importance: 1.0,
		});

		const results = recall(beam, "phoenix migration", 2, {
			importanceWeight: 0.8,
			ftsWeight: 0.1,
			vecWeight: 0.1,
		});

		expect(results[0]?.id).toBe("wm-high");
		expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
	});

	it("handles CJK token queries without embeddings", () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-cjk", "数据库 密码 已轮换");
		insertWorking(beam, "wm-other", "unrelated english note");

		const results = recall(beam, "数据库", 3);

		expect(results[0]?.id).toBe("wm-cjk");
		expect(results.map(result => result.id)).not.toContain("wm-other");
	});

	it("formats context in bullet and JSON sandwich sections", () => {
		const beam = makeBeam();
		const results = [
			{
				id: "a",
				content: "highest confidence fact",
				source: "unit",
				timestamp: "2026-05-30T00:00:00.000Z",
				score: 0.9,
			},
			{
				id: "b",
				content: "supporting fact",
				source: "unit",
				timestamp: "2026-05-29T00:00:00.000Z",
				score: 0.5,
			},
		];

		const bullet = formatContext(beam, results);
		const json = JSON.parse(formatContext(beam, results, "json")) as {
			top_facts: string[];
			supporting_context: string[];
		};

		expect(bullet).toContain("## Top Facts");
		expect(bullet).toContain("highest confidence fact");
		expect(json.top_facts[0]).toContain("highest confidence fact");
		expect(json.supporting_context[0]).toContain("supporting fact");
	});

	it("recalls structured facts via FTS and LIKE fallback shape", () => {
		const beam = makeBeam();
		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["fact-1", beam.sessionId, "service", "uses", "postgres database", "2026-05-30T00:00:00.000Z", 0.91],
		);

		const results = factRecall(beam, "postgres", 3);

		expect(results).toHaveLength(1);
		expect(results[0]?.content).toBe("postgres database");
		expect(results[0]?.fact_id).toBe("fact-1");
		expect(results[0]?.subject).toBe("service");
	});

	it("enhanced recall applies intent/synonym/MMR path without dropping required fields", () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-db", "database migration notes mention postgres");
		insertWorking(beam, "wm-cache", "cache migration notes mention redis");

		const results = recallEnhanced(beam, "db migration", 2, { useCache: false });

		expect(results).toHaveLength(2);
		expect(results[0]?.id).toBeTruthy();
		expect(typeof results[0]?.score).toBe("number");
		expect(results[0]?.explanation).toBeTruthy();
	});
});
