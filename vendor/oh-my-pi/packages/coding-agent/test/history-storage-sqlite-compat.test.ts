import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readTableSql } from "./helpers/sqlite-inspect";

const LEGACY_TIMESTAMP = 1_700_000_000;

let tempDir: TempDir | null = null;

beforeEach(() => {
	HistoryStorage.resetInstance();
});

afterEach(async () => {
	HistoryStorage.resetInstance();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

it("migrates legacy history schema away from unixepoch defaults", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-legacy-");
	const dbPath = tempDir.join("history.db");
	const legacyDb = new Database(dbPath);
	legacyDb.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			cwd TEXT
		);
	`);
	legacyDb
		.prepare("INSERT INTO history (prompt, created_at, cwd) VALUES (?, ?, ?)")
		.run("legacy prompt", LEGACY_TIMESTAMP, "/tmp/legacy");
	legacyDb.close();

	const storage = HistoryStorage.open(dbPath);
	await storage.add("new prompt", "/tmp/new");

	const db = new Database(dbPath, { readonly: true });
	try {
		const prompts = db.prepare("SELECT prompt FROM history ORDER BY id ASC").all() as Array<{ prompt: string }>;
		expect(prompts).toEqual([{ prompt: "legacy prompt" }, { prompt: "new prompt" }]);
		expect(readTableSql(dbPath, "history")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "history")).toContain("strftime('%s','now')");
		const indexRow = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_history_created_at'")
			.get() as { present?: number } | undefined;
		expect(indexRow?.present).toBe(1);
		const ftsRow = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'history_fts'")
			.get() as { present?: number } | undefined;
		expect(ftsRow?.present).toBe(1);
	} finally {
		db.close();
	}
});
