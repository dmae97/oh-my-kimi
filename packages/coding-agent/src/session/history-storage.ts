import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getHistoryDbPath, logger } from "@oh-my-pi/pi-utils";

export interface HistoryEntry {
	id: number;
	prompt: string;
	created_at: number;
	cwd?: string;
}

type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();

	constructor(readonly delayMs: number = 0) {}

	push(value: T, hnd: (values: T[]) => Promise<void> | void): Promise<void> {
		let queue = this.#queue;
		if (!queue) {
			this.#queue = queue = [];
			this.#promise = new Promise((resolve, reject) => {
				const exec = () => {
					try {
						if (this.#queue === queue) {
							this.#queue = undefined;
						}
						resolve(hnd(queue!));
					} catch (error) {
						reject(error);
					}
				};

				if (this.delayMs > 0) {
					setTimeout(exec, this.delayMs);
				} else {
					queueMicrotask(exec);
				}
			});
		}
		queue.push(value);
		return this.#promise;
	}
}

export class HistoryStorage {
	#db: Database;
	static #instance?: HistoryStorage;
	#drain = new AsyncDrain<Pick<HistoryEntry, "prompt" | "cwd">>(100);

	// Prepared statements
	#insertRowStmt: Statement;
	#recentStmt: Statement;
	#searchStmt: Statement;
	#lastPromptStmt: Statement;

	// In-memory cache of last prompt to avoid sync DB reads on add
	#lastPromptCache: string | null = null;

	private constructor(dbPath: string) {
		this.#ensureDir(dbPath);

		this.#db = new Database(dbPath);

		const hasFts = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();

		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
	END;
	`);

		if (this.#historySchemaUsesUnixEpoch()) {
			this.#migrateHistorySchema();
		}

		if (!hasFts) {
			try {
				this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
			}
		}

		this.#recentStmt = this.#db.prepare(
			"SELECT id, prompt, created_at, cwd FROM history ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#searchStmt = this.#db.prepare(
			"SELECT h.id, h.prompt, h.created_at, h.cwd FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?",
		);
		this.#lastPromptStmt = this.#db.prepare("SELECT prompt FROM history ORDER BY id DESC LIMIT 1");

		this.#insertRowStmt = this.#db.prepare("INSERT INTO history (prompt, cwd) VALUES (?, ?)");

		const last = this.#lastPromptStmt.get() as { prompt?: string } | undefined;
		this.#lastPromptCache = last?.prompt ?? null;
	}

	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		if (!HistoryStorage.#instance) {
			HistoryStorage.#instance = new HistoryStorage(dbPath);
		}
		return HistoryStorage.#instance;
	}

	/** @internal Reset the singleton — test-only. */
	static resetInstance(): void {
		HistoryStorage.#instance = undefined;
	}

	#insertBatch(rows: Array<Pick<HistoryEntry, "prompt" | "cwd">>): void {
		this.#db.transaction((rows: Array<Pick<HistoryEntry, "prompt" | "cwd">>) => {
			for (const row of rows) {
				this.#insertRowStmt.run(row.prompt, row.cwd ?? null);
			}
		})(rows);
	}

	add(prompt: string, cwd?: string): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed) return Promise.resolve();
		if (this.#lastPromptCache === trimmed) return Promise.resolve();
		this.#lastPromptCache = trimmed;
		return this.#drain.push({ prompt: trimmed, cwd: cwd ?? undefined }, rows => {
			this.#insertBatch(rows);
		});
	}

	getRecent(limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		try {
			const rows = this.#recentStmt.all(safeLimit) as HistoryRow[];
			return rows.map(row => this.#toEntry(row));
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	search(query: string, limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const ftsQuery = this.#buildFtsQuery(query);
		if (!ftsQuery) return [];

		try {
			const rows = this.#searchStmt.all(ftsQuery, safeLimit) as HistoryRow[];
			return rows.map(row => this.#toEntry(row));
		} catch (error) {
			logger.error("HistoryStorage search failed", { error: String(error) });
			return [];
		}
	}

	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });
	}

	#historySchemaUsesUnixEpoch(): boolean {
		const row = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history'").get() as
			| { sql?: string | null }
			| undefined;
		return row?.sql?.includes("unixepoch(") ?? false;
	}

	#migrateHistorySchema(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE history RENAME TO history_legacy");
			this.#db.run("DROP INDEX IF EXISTS idx_history_created_at");
			this.#db.run("DROP TRIGGER IF EXISTS history_ai");
			this.#db.run("DROP TABLE IF EXISTS history_fts");
			this.#db.run(`
CREATE TABLE history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
INSERT INTO history (id, prompt, created_at, cwd)
SELECT id, prompt, created_at, cwd
FROM history_legacy;
DROP TABLE history_legacy;
CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id');
CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
			`);
			this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		});
		migrate();
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	#buildFtsQuery(query: string): string | null {
		const tokens = query
			.trim()
			.split(/\s+/)
			.map(token => token.trim())
			.filter(Boolean);

		if (tokens.length === 0) return null;

		return tokens
			.map(token => {
				const escaped = token.replace(/"/g, '""');
				return `"${escaped}"*`;
			})
			.join(" ");
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: row.id,
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
		};
	}
}
