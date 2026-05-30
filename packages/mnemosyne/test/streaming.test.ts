import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBeam } from "../src/core/beam";
import { DeltaSync, EventType, MemoryEvent, MemoryStream, SyncCheckpoint } from "../src/core/streaming";

describe("MemoryEvent", () => {
	it("serializes and restores Python-shaped events", () => {
		const event = new MemoryEvent({
			event_type: EventType.MEMORY_ADDED,
			memory_id: "mem_123",
			session_id: "sess",
			content: "Test",
			importance: 0.7,
		});
		expect(event.to_dict().event_type).toBe("MEMORY_ADDED");
		expect(JSON.parse(event.to_json()).memory_id).toBe("mem_123");
		const restored = MemoryEvent.from_dict({
			event_type: "MEMORY_RECALLED",
			memory_id: "mem_456",
			timestamp: "2026-01-01T00:00:00",
			content: "Recalled",
		});
		expect(restored.event_type).toBe(EventType.MEMORY_RECALLED);
		expect(restored.memory_id).toBe("mem_456");
	});
});

describe("MemoryStream", () => {
	it("invokes typed and any callbacks while isolating exceptions", () => {
		const stream = new MemoryStream(10);
		const calls: string[] = [];
		stream.on(EventType.MEMORY_ADDED, () => {
			throw new Error("boom");
		});
		stream.on(EventType.MEMORY_ADDED, event => calls.push(event.memory_id));
		stream.on_any(event => calls.push(`any:${event.memory_id}`));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "a" }));
		expect(calls).toEqual(["a", "any:a"]);
	});

	it("keeps a bounded filterable buffer", () => {
		const stream = new MemoryStream(3);
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "old" }));
		const since = new Date().toISOString();
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_RECALLED, memory_id: "b" }));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "c" }));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "d" }));
		expect(stream.get_buffer().map(event => event.memory_id)).toEqual(["b", "c", "d"]);
		expect(stream.get_buffer([EventType.MEMORY_ADDED], since).map(event => event.memory_id)).toEqual(["c", "d"]);
		stream.clear_buffer();
		expect(stream.get_buffer()).toHaveLength(0);
	});

	it("feeds async listeners with type filtering", async () => {
		const stream = new MemoryStream();
		const iterator = stream.listen([EventType.MEMORY_RECALLED]);
		const next = iterator.next();
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "skip" }));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_RECALLED, memory_id: "hit" }));
		await expect(next).resolves.toMatchObject({ value: { memoryId: "hit" }, done: false });
		await iterator.return();
	});
});

describe("DeltaSync", () => {
	it("computes, applies, and persists checkpoints for allowed tables", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemosyne-stream-"));
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, ?, ?, ?, ?)",
				["wm1", "Memory 1", "test", "2026-01-01T00:00:00", "s", 0.5],
			);
			const sync = new DeltaSync({ db }, root);
			const delta = sync.compute_delta("peer", "working_memory");
			expect(delta).toHaveLength(1);
			const stats = sync.apply_delta(
				"peer",
				[{ id: "wm2", content: "Imported", source: "remote", importance: 0.9 }],
				"working_memory",
			);
			expect(stats.inserted).toBe(1);
			expect(sync.get_checkpoint("peer")?.peer_id).toBe("peer");
			const reloaded = new DeltaSync({ db }, root);
			expect(reloaded.get_checkpoint("peer")?.peer_id).toBe("peer");
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes checkpoints", () => {
		const checkpoint = new SyncCheckpoint({
			peer_id: "p1",
			last_sync_at: "2026-01-01T00:00:00",
			last_rowid: 42,
		});
		expect(JSON.parse(checkpoint.to_json()).last_rowid).toBe(42);
	});
});
