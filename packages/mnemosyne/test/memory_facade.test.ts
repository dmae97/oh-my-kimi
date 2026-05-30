import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	forget,
	get,
	get_bank,
	get_context,
	get_stats,
	Mnemosyne,
	recall,
	recall_enhanced,
	remember,
	resetDefaultInstanceForTests,
	scratchpad_clear,
	scratchpad_read,
	scratchpad_write,
	set_bank,
	sleep,
	sleep_all_sessions,
	update,
} from "../src/core/memory";
import { openDatabase } from "../src/db";

const roots: string[] = [];
let previousDataDir: string | undefined;

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemosyne-memory-facade-"));
	roots.push(root);
	return root;
}

function useTempDataDir(): string {
	const root = tempRoot();
	previousDataDir = process.env.MNEMOSYNE_DATA_DIR;
	process.env.MNEMOSYNE_DATA_DIR = root;
	return root;
}

afterEach(() => {
	resetDefaultInstanceForTests();
	if (previousDataDir === undefined) {
		delete process.env.MNEMOSYNE_DATA_DIR;
	} else {
		process.env.MNEMOSYNE_DATA_DIR = previousDataDir;
	}
	previousDataDir = undefined;
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Mnemosyne facade", () => {
	it("wraps BeamMemory for instance remember, recall, get, update, forget, stats, and context", () => {
		const dbPath = join(tempRoot(), "mnemosyne.db");
		const memory = new Mnemosyne({
			dbPath,
			sessionId: "session-a",
			authorId: "abdias",
			authorType: "human",
			channelId: "team-a",
		});
		try {
			const id = memory.remember("Dark mode preference", {
				importance: 0.9,
				metadata: { topic: "ui" },
			});

			expect(memory.recall("dark", 5, { authorId: "abdias" })[0]).toMatchObject({
				id,
				author_id: "abdias",
				author_type: "human",
				channel_id: "team-a",
			});
			expect(memory.get(id)).toMatchObject({ id, content: "Dark mode preference" });
			expect(memory.getContext(1)[0]).toMatchObject({ id, content: "Dark mode preference" });
			expect(memory.getStats()).toMatchObject({
				total_memories: 1,
				mode: "beam",
				database: dbPath,
			});
			expect(memory.update(id, "Dark mode preference updated", 0.95)).toBe(true);
			expect(memory.get(id)).toMatchObject({
				content: "Dark mode preference updated",
				importance: 0.95,
			});
			expect(memory.forget(id)).toBe(true);
			expect(memory.get(id)).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("accepts an already-open Database handle", () => {
		const db = openDatabase(":memory:");
		const memory = new Mnemosyne({ db, sessionId: "external-db" });
		try {
			const id = memory.remember("External database handle memory");
			expect(memory.conn).toBe(db);
			expect(memory.get(id)).toMatchObject({ content: "External database handle memory" });
		} finally {
			memory.close();
			db.close();
		}
	});

	it("preserves legacy and Python-compatible aliases", () => {
		const memory = new Mnemosyne({
			dbPath: join(tempRoot(), "mnemosyne.db"),
			session_id: "aliases",
		});
		try {
			const id = memory.addMemory("Alias memory", { source: "test" });
			expect(memory.saveMemory("Saved alias")).toHaveLength(16);
			expect(memory.storeMemory("Stored alias")).toHaveLength(16);
			expect(memory.search("alias").some(row => row.id === id)).toBe(true);
			expect(memory.query("alias").some(row => row.id === id)).toBe(true);
			expect(memory.get_context(2).length).toBeGreaterThanOrEqual(1);
			expect(memory.get_stats().beam).toBeDefined();
			expect(Array.isArray(memory.recall_enhanced("alias"))).toBe(true);
			const scratchId = memory.scratchpad_write("scratch alias");
			expect(scratchId).toHaveLength(16);
			expect(memory.scratchpad_read().map(row => (row as { content: string }).content)).toEqual(["scratch alias"]);
			memory.scratchpad_clear();
			expect(memory.scratchpadRead()).toEqual([]);
			expect(memory.sleep(true).dry_run).toBe(true);
			expect(memory.sleep_all_sessions(true).dry_run).toBe(true);
		} finally {
			memory.close();
		}
	});

	it("exposes module-level singleton functions and resets cleanly for tests", () => {
		useTempDataDir();
		const id = remember("Module-level memory", { importance: 0.8 });

		expect(recall("module", 5).some(row => row.id === id)).toBe(true);
		expect(get(id)).toMatchObject({ content: "Module-level memory" });
		expect(get_context(1)[0]).toMatchObject({ id });
		expect(get_stats()).toMatchObject({ total_memories: 1 });
		expect(update(id, "Module-level memory updated", 0.9)).toBe(true);
		expect(Array.isArray(recall_enhanced("updated", 5))).toBe(true);
		const padId = scratchpad_write("module scratch");
		expect(padId).toHaveLength(16);
		expect(scratchpad_read().map(row => (row as { content: string }).content)).toEqual(["module scratch"]);
		scratchpad_clear();
		expect(scratchpad_read()).toEqual([]);
		expect(sleep(true).dry_run).toBe(true);
		expect(sleep_all_sessions(true).dry_run).toBe(true);
		expect(forget(id)).toBe(true);
		resetDefaultInstanceForTests();
		expect(get_bank()).toBe("default");
	});

	it("switches singleton banks and supports per-call bank selection", () => {
		useTempDataDir();
		set_bank("work");
		expect(get_bank()).toBe("work");
		const workId = remember("Work bank memory");
		const personalId = remember("Personal bank memory", { bank: "personal" });

		expect(get_bank()).toBe("personal");
		expect(recall("personal", 5).map(row => row.id)).toContain(personalId);
		expect(recall("work", 5, { bank: "work" }).map(row => row.id)).toContain(workId);
		expect(get(workId, "personal")).toBeNull();
		expect(get(personalId, "personal")).toMatchObject({ content: "Personal bank memory" });
	});
});
