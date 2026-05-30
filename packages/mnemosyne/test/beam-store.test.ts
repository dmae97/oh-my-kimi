import { afterEach, describe, expect, it } from "bun:test";
import { initBeam } from "../src/core/beam/schema";
import {
	exportToDict,
	forgetWorking,
	get,
	getContext,
	getGlobalWorkingStats,
	getWorkingStats,
	importFromDict,
	invalidate,
	remember,
	rememberBatch,
	scratchpadClear,
	scratchpadRead,
	scratchpadWrite,
	updateWorking,
} from "../src/core/beam/store";
import type { BeamEvent, BeamMemoryState } from "../src/core/beam/types";
import { openDatabase } from "../src/db";

const states: BeamMemoryState[] = [];

function makeState(sessionId = "session-a", events: BeamEvent[] = []): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: event => {
			events.push(event);
		},
		pluginManager: {
			emit: event => {
				events.push({ ...event, type: `plugin:${event.type}` });
			},
		},
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
	};
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

describe("beam store free functions", () => {
	it("remembers one item, deduplicates exact content, emits events, and keeps FTS in sync", () => {
		const events: BeamEvent[] = [];
		const beam = makeState("session-a", events);

		const id = remember(beam, "User prefers terse answers", {
			source: "conversation",
			importance: 0.8,
			metadata: { topic: "style" },
			veracity: "stated",
		});
		const duplicate = remember(beam, "User prefers terse answers", {
			importance: 0.9,
			veracity: "unknown",
		});

		expect(duplicate).toBe(id);
		expect(events.map(event => event.type)).toEqual([
			"MEMORY_ADDED",
			"plugin:MEMORY_ADDED",
			"MEMORY_UPDATED",
			"plugin:MEMORY_UPDATED",
		]);
		const row = get(beam, id);
		expect(row?.memory_store).toBe("working");
		expect(row?.content).toBe("User prefers terse answers");
		expect(row?.importance).toBe(0.9);
		expect(row?.veracity).toBe("stated");

		const ftsRows = beam.db.prepare("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("terse") as {
			id: string;
		}[];
		expect(ftsRows.map(row => row.id)).toEqual([id]);
	});

	it("batch remembers items and returns context ordered by global scope, importance, then recency", () => {
		const beam = makeState();
		const ids = rememberBatch(
			beam,
			[
				{ content: "Local low priority", importance: 0.1, timestamp: "2026-05-30T00:00:00.000Z" },
				{
					content: "Global rule always include",
					importance: 0.2,
					scope: "global",
					timestamp: "2026-05-30T00:01:00.000Z",
				},
				{ content: "Local high priority", importance: 0.9, timestamp: "2026-05-30T00:02:00.000Z" },
			],
			{ veracity: "imported" },
		);
		expect(rememberBatch).toBe(rememberBatch);

		expect(ids).toHaveLength(3);
		expect(getContext(beam, 3).map(row => row.content)).toEqual([
			"Global rule always include",
			"Local high priority",
			"Local low priority",
		]);
		expect(getWorkingStats(beam)).toMatchObject({ total: 3, count: 3 });
		expect(getGlobalWorkingStats(beam)).toMatchObject({ total: 3, count: 3 });
	});

	it("updates, invalidates, gets episodic fallback, forgets with authorized annotation cascade, and reports scoped stats", () => {
		const beam = makeState();
		const id = remember(beam, "Old wording", { importance: 0.2 });
		beam.db.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'mentions', 'Alice')").run(id);
		beam.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, veracity) VALUES (?, ?, 'sleep', ?, ?, 0.7, '{}', 'unknown')",
			)
			.run("episodic-1", "Episodic fallback", "2026-05-30T00:00:00.000Z", beam.sessionId);

		expect(updateWorking(beam, id, "New wording", 0.6)).toBe(true);
		expect(get(beam, id)?.content).toBe("New wording");
		expect(
			(
				beam.db.prepare("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("New") as {
					id: string;
				}[]
			).map(row => row.id),
		).toEqual([id]);
		expect(get(beam, "episodic-1")?.memory_store).toBe("episodic");
		expect(getWorkingStats(beam, "author-a", "user", "channel-a")).toMatchObject({ total: 1 });
		expect(invalidate(beam, id, "replacement-1")).toBe(true);
		expect(getContext(beam, 10).some(row => row.id === id)).toBe(false);
		expect(forgetWorking(beam, id)).toBe(true);
		expect(get(beam, id)).toBeNull();
		expect(beam.db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE memory_id = ?").get(id)).toEqual({
			count: 0,
		});
		expect(forgetWorking(beam, id)).toBe(false);
	});

	it("keeps scratchpad scoped to the active session", () => {
		const first = makeState("session-a");
		const second = makeState("session-b");
		const firstId = scratchpadWrite(first, "draft note");
		scratchpadWrite(second, "other session note");

		expect(firstId).toHaveLength(16);
		expect(scratchpadRead(first).map(row => row.content)).toEqual(["draft note"]);
		scratchpadClear(first);
		expect(scratchpadRead(first)).toEqual([]);
		expect(scratchpadRead(second).map(row => row.content)).toEqual(["other session note"]);
	});

	it("exports and imports working memory, episodic memory, scratchpad, and consolidation log idempotently", () => {
		const source = makeState("source-session");
		const id = remember(source, "Exported working memory", { veracity: "tool", importance: 0.75 });
		scratchpadWrite(source, "portable scratch");
		source.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, summary_of) VALUES ('episode-1', 'Exported episode', 'sleep', '2026-05-30T00:00:00.000Z', 'source-session', 0.6, '{}', ?)",
			)
			.run(id);
		source.db
			.prepare(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES ('source-session', 1, 'Exported', '2026-05-30T00:00:00.000Z')",
			)
			.run();

		const exported = exportToDict(source);
		expect(exported.working_memory as unknown[]).toHaveLength(1);
		expect(exported.scratchpad as unknown[]).toHaveLength(1);

		const dest = makeState("dest-session");
		expect(importFromDict(dest, exported)).toEqual({
			working_memory: { inserted: 1, skipped: 0, overwritten: 0 },
			episodic_memory: { inserted: 1, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
			scratchpad: { inserted: 1, updated: 0 },
			consolidation_log: { inserted: 1 },
		});
		expect(importFromDict(dest, exported)).toMatchObject({
			working_memory: { inserted: 0, skipped: 1, overwritten: 0 },
			episodic_memory: { inserted: 0, skipped: 1, overwritten: 0 },
			scratchpad: { inserted: 0, updated: 1 },
			consolidation_log: { inserted: 1 },
		});
		expect(importFromDict(dest, exported, true)).toMatchObject({
			working_memory: { inserted: 0, skipped: 0, overwritten: 1 },
			episodic_memory: { inserted: 0, skipped: 0, overwritten: 1 },
		});
		expect(get(dest, id)?.content).toBe("Exported working memory");
		expect(dest.db.prepare("SELECT COUNT(*) AS count FROM scratchpad").get()).toEqual({ count: 1 });
		expect(scratchpadRead(dest).map(row => row.content)).toEqual([]);
	});
});
