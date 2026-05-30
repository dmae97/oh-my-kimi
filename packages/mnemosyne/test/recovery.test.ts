import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createBackup, restoreBackup, verifyIntegrity } from "../src/dr/recovery";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemosyne-recovery-"));
	tempDirs.push(dir);
	return dir;
}

function createSqliteDb(path: string): void {
	const db = new Database(path, { create: true, readwrite: true, strict: true });
	try {
		db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
		db.prepare("INSERT INTO memories (content) VALUES (?)").run("backup me");
	} finally {
		db.close();
	}
}

function readMemory(path: string): string {
	const db = new Database(path, { create: false, readwrite: false, strict: true });
	try {
		const row = db.query("SELECT content FROM memories WHERE id = 1").get() as {
			content: string;
		} | null;
		expect(row).not.toBeNull();
		if (row === null) throw new Error("Expected memory row to exist");
		return row.content;
	} finally {
		db.close();
	}
}

afterEach(() => {
	for (;;) {
		const dir = tempDirs.pop();
		if (dir === undefined) break;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SQLite recovery helpers", () => {
	it("creates a compressed backup with metadata", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemosyne.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);

		const backup = createBackup(dbPath, backupDir);

		expect(backup.backup_path.startsWith(backupDir)).toBe(true);
		expect(backup.backup_path.endsWith(".db.gz")).toBe(true);
		expect(existsSync(backup.backup_path)).toBe(true);
		expect(existsSync(backup.metadata_path)).toBe(true);
		expect(backup.original_size).toBe(statSync(dbPath).size);
		expect(backup.backup_size).toBe(statSync(backup.backup_path).size);
		expect(backup.compressed).toBe(true);
		expect(
			Buffer.from(gunzipSync(readFileSync(backup.backup_path)))
				.subarray(0, 16)
				.toString("binary"),
		).toBe("SQLite format 3\0");
	});

	it("returns true for a valid SQLite database integrity check", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemosyne.db");
		createSqliteDb(dbPath);

		expect(verifyIntegrity(dbPath)).toBe(true);
	});

	it("restores a backup to a new path", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemosyne.db");
		const restoredPath = join(dir, "restored.db");
		createSqliteDb(dbPath);
		const backup = createBackup(dbPath, join(dir, "backups"));

		const restored = restoreBackup(backup.backup_path, restoredPath);

		expect(restored).toEqual({
			restored: true,
			backup_used: backup.backup_path,
			database_path: restoredPath,
			integrity_check: true,
		});
		expect(verifyIntegrity(restoredPath)).toBe(true);
		expect(readMemory(restoredPath)).toBe("backup me");
	});
});
