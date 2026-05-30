import { logger, toError } from "@oh-my-pi/pi-utils";
import type { SessionStorage, SessionStorageStat, SessionStorageWriter } from "./session-storage";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / concat syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * Minimal subset of the `Bun.SQL` instance surface used by
 * {@link SqlSessionStorage}. The real client exposes a callable
 * tagged-template too; we only ever call `unsafe()` so the contract here is
 * narrow — making it trivial to swap in a test double or wrap a pooled
 * client.
 */
export interface SqlSessionStorageClient {
	unsafe(query: string, values?: unknown[]): Promise<unknown[]>;
	/**
	 * `Bun.SQL` exposes the parsed connection options here. We only consult
	 * `adapter` to pick the dialect; the field is typed as
	 * `string | undefined` so the real `Bun.SQL` instance type slots in
	 * without casting (it reports `string | undefined` across adapters).
	 */
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
}

export interface SqlSessionStorageOptions {
	/** Connected `Bun.SQL` instance (PostgreSQL, MySQL, or SQLite). */
	client: SqlSessionStorageClient;
	/**
	 * Override the auto-detected adapter. Useful when the client is wrapped
	 * (e.g. by a pool) and `client.options.adapter` is unreliable.
	 */
	adapter?: SqlSessionStorageAdapter;
	/**
	 * Table name to use. Default: `omp_session_files`. Must match
	 * `[A-Za-z_][A-Za-z0-9_]{0,62}` — inlined into prepared statements at
	 * startup, so we accept identifier-safe inputs only (no quoted/dotted
	 * names).
	 */
	table?: string;
	/**
	 * If true, run `CREATE TABLE IF NOT EXISTS` during `create()`.
	 * Default: true. Disable when the table is owned by an external
	 * migration.
	 */
	createTable?: boolean;
}

interface MirrorEntry {
	content: string;
	mtimeMs: number;
}

interface DialectQueries {
	createTable: string;
	/** Insert or replace the full content for `path`. Used for `writeText`/`flags="w"` truncate. */
	upsertReplace: string;
	/** Insert if missing; otherwise append the new chunk to existing content. Used for `writeLine`. */
	upsertAppend: string;
	/** Delete a single row by path. */
	delete: string;
	/** Delete every row whose `path` starts with the supplied LIKE pattern. */
	deletePrefix: string;
	/** Move a row from one path to another (caller deletes any conflicting destination first). */
	rename: string;
	/** Read everything for the in-memory mirror warm-up. */
	selectAll: string;
}

const DEFAULT_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LIKE_ESCAPE_CHAR = "#";
const LIKE_ESCAPE_RE = /[%_#]/g;

function enoent(p: string): NodeJS.ErrnoException {
	const err = new Error(`ENOENT: no such file, '${p}'`) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	err.errno = -2;
	err.path = p;
	err.syscall = "open";
	return err;
}

function matchesGlob(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
	return name === pattern;
}

function escapeLikeLiteral(value: string): string {
	return value.replace(LIKE_ESCAPE_RE, ch => `${LIKE_ESCAPE_CHAR}${ch}`);
}

function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

function buildQueries(adapter: SqlSessionStorageAdapter, table: string): DialectQueries {
	const placeholder = adapter === "postgres" ? (n: number): string => `$${n}` : (_n: number): string => "?";

	if (adapter === "mysql") {
		return {
			createTable:
				`CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL` +
				`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			upsertReplace:
				`INSERT INTO ${table} (path, content, mtime_ms) VALUES (?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = VALUES(content), mtime_ms = VALUES(mtime_ms)`,
			upsertAppend:
				`INSERT INTO ${table} (path, content, mtime_ms) VALUES (?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = CONCAT(content, VALUES(content)), mtime_ms = VALUES(mtime_ms)`,
			delete: `DELETE FROM ${table} WHERE path = ?`,
			deletePrefix: `DELETE FROM ${table} WHERE path LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`,
			rename: `UPDATE ${table} SET path = ?, mtime_ms = ? WHERE path = ?`,
			selectAll: `SELECT path, content, mtime_ms FROM ${table}`,
		};
	}

	// PostgreSQL + SQLite — both support `ON CONFLICT(path) DO UPDATE …` and
	// `||` for string concatenation. The `excluded` keyword references the
	// row that would have been inserted, in both engines.
	const mtimeType = adapter === "postgres" ? "BIGINT" : "INTEGER";
	const tableQualifier = `${table}.content`;
	return {
		createTable:
			`CREATE TABLE IF NOT EXISTS ${table} (` +
			`path TEXT PRIMARY KEY, ` +
			`content TEXT NOT NULL, ` +
			`mtime_ms ${mtimeType} NOT NULL` +
			`)`,
		upsertReplace:
			`INSERT INTO ${table} (path, content, mtime_ms) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms`,
		upsertAppend:
			`INSERT INTO ${table} (path, content, mtime_ms) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = ${tableQualifier} || excluded.content, mtime_ms = excluded.mtime_ms`,
		delete: `DELETE FROM ${table} WHERE path = ${placeholder(1)}`,
		deletePrefix: `DELETE FROM ${table} WHERE path LIKE ${placeholder(1)} ESCAPE '${LIKE_ESCAPE_CHAR}'`,
		rename: `UPDATE ${table} SET path = ${placeholder(1)}, mtime_ms = ${placeholder(2)} WHERE path = ${placeholder(3)}`,
		selectAll: `SELECT path, content, mtime_ms FROM ${table}`,
	};
}

interface DbRow {
	path: string;
	content: string;
	mtime_ms: number | bigint | string;
}

function rowMtime(value: number | bigint | string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file maps to a row keyed by `path`; one table stores
 * everything.
 *
 * Works against PostgreSQL, MySQL/MariaDB, and SQLite by selecting the
 * dialect-correct DDL, upsert, and string-concat syntax at construction.
 *
 * Trade-offs vs `FileSessionStorage`:
 * - An in-memory mirror is loaded on construction so the interface's
 *   synchronous methods (`existsSync`, `statSync`, `listFilesSync`, …) keep
 *   their contracts; `bun:sql` is async only. Mirror state is process-local,
 *   matching `FileSessionStorage`'s existing single-writer assumption — peer
 *   processes need {@link refresh} to pick up out-of-band writes.
 * - `writeLineSync` updates the mirror synchronously and queues an async
 *   upsert that appends the line to the existing row (or inserts it as the
 *   first chunk). The promise is awaited by `flush()` / `close()` /
 *   {@link drain}. A SIGKILL between the sync mirror update and the network
 *   round-trip loses the last line.
 * - Blobs (image data) and tool artifact files still live on disk via
 *   `BlobStore` / `ArtifactManager`. Those are out of scope for this storage.
 */
export class SqlSessionStorage implements SessionStorage {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #q: DialectQueries;
	readonly #mirror = new Map<string, MirrorEntry>();
	readonly #writers = new Set<SqlSessionStorageWriter>();
	#nextMtimeMs = 0;
	#pendingTail: Promise<void> = Promise.resolve();

	private constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(`SqlSessionStorage: table name must match ${IDENT_RE.source} (got ${JSON.stringify(table)})`);
		}
		this.#table = table;
		this.#q = buildQueries(this.#adapter, table);
	}

	/**
	 * Apply the dialect-correct DDL (unless `createTable: false` is set) and
	 * warm the in-memory mirror with every existing row. Must be awaited
	 * before passing the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const storage = new SqlSessionStorage(options);
		if (options.createTable !== false) {
			await storage.#client.unsafe(storage.#q.createTable);
		}
		await storage.refresh();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	/**
	 * Re-load the mirror from the database. Call this from a different
	 * process that took over the table, or after an out-of-band write made
	 * by another agent.
	 */
	async refresh(): Promise<void> {
		this.#mirror.clear();
		const rows = (await this.#client.unsafe(this.#q.selectAll)) as DbRow[];
		for (const row of rows) {
			const mtimeMs = rowMtime(row.mtime_ms);
			this.#mirror.set(row.path, { content: row.content, mtimeMs });
			if (mtimeMs > this.#nextMtimeMs) this.#nextMtimeMs = mtimeMs;
		}
	}

	/**
	 * Resolve once every pending background write (issued via `writeTextSync`
	 * or `writer.writeLineSync`) has been acknowledged by the database.
	 * Throws if any background write failed since the last drain. Call on
	 * graceful shutdown to avoid losing the last unflushed line.
	 */
	async drain(): Promise<void> {
		// Take ownership of the current tail, then reset so subsequent
		// operations start from a clean (resolved) chain. Without the reset,
		// any failure observed here would also be re-thrown by every later
		// write that piggybacks on the tail via `#trackPending`.
		const tail = this.#pendingTail;
		this.#pendingTail = Promise.resolve();
		await tail;
	}

	/**
	 * Allocate a strictly monotonic mtime. Two writes within the same
	 * millisecond would otherwise yield identical `mtimeMs` values and break
	 * `getSortedSessions`' newest-first ordering.
	 */
	#allocMtimeMs(): number {
		const now = Date.now();
		const next = now > this.#nextMtimeMs ? now : this.#nextMtimeMs + 1;
		this.#nextMtimeMs = next;
		return next;
	}

	#trackPending(promise: Promise<void>): void {
		// `Promise.all` rejects when either input rejects, which is exactly
		// what we want for `drain()`. The follow-up `.catch(() => {})` only
		// silences the unhandled-rejection signal on the shared tail —
		// `drain()` keeps its own handler chain and still observes the
		// original error, because rejection delivery is per-handler-chain.
		this.#pendingTail = Promise.all([this.#pendingTail, promise]).then(() => {});
		this.#pendingTail.catch(() => {});
	}

	// --- sync surface ---------------------------------------------------------

	ensureDirSync(_dir: string): void {
		// SQL is flat: directories are derived from key prefixes.
	}

	existsSync(path: string): boolean {
		return this.#mirror.has(path);
	}

	writeTextSync(path: string, content: string): void {
		const mtimeMs = this.#allocMtimeMs();
		this.#mirror.set(path, { content, mtimeMs });
		this.#trackPending(this.#upsertReplace(path, content, mtimeMs));
	}

	readTextSync(path: string): string {
		const entry = this.#mirror.get(path);
		if (!entry) throw enoent(path);
		return entry.content;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#mirror.get(path);
		if (!entry) throw enoent(path);
		return {
			size: Buffer.byteLength(entry.content, "utf-8"),
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const out: string[] = [];
		for (const path of this.#mirror.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/")) continue;
			if (!matchesGlob(name, pattern)) continue;
			out.push(path);
		}
		return out;
	}

	// --- async surface --------------------------------------------------------

	async exists(path: string): Promise<boolean> {
		return this.#mirror.has(path);
	}

	async readText(path: string): Promise<string> {
		const entry = this.#mirror.get(path);
		if (!entry) throw enoent(path);
		return entry.content;
	}

	async readTextPrefix(path: string, maxBytes: number): Promise<string> {
		const entry = this.#mirror.get(path);
		if (!entry) throw enoent(path);
		if (maxBytes <= 0) return "";
		// `entry.content` is a JS string (UTF-16 code units); the prefix
		// contract is byte-oriented. Encode to UTF-8, slice, then decode —
		// matching `peekFile`'s behaviour for the file-backed storage.
		const bytes = Buffer.from(entry.content, "utf-8");
		const slice = bytes.subarray(0, Math.min(maxBytes, bytes.byteLength));
		return slice.toString("utf-8");
	}

	async writeText(path: string, content: string): Promise<void> {
		const mtimeMs = this.#allocMtimeMs();
		this.#mirror.set(path, { content, mtimeMs });
		await this.#upsertReplace(path, content, mtimeMs);
	}

	async rename(src: string, dst: string): Promise<void> {
		const entry = this.#mirror.get(src);
		if (!entry) throw enoent(src);
		// Update the mirror first so a synchronous existsSync() right after
		// the await resolves consistently. If the DB update fails the mirror
		// is rolled back below.
		const dstPrev = this.#mirror.get(dst);
		this.#mirror.delete(src);
		this.#mirror.set(dst, entry);

		try {
			// `fs.promises.rename` overwrites the destination when one
			// exists; mirror that here so the JSONL atomic-rewrite flow
			// (temp file → rename) keeps working unchanged.
			if (dstPrev !== undefined) {
				await this.#client.unsafe(this.#q.delete, [dst]);
			}
			await this.#client.unsafe(this.#q.rename, [dst, entry.mtimeMs, src]);
		} catch (err) {
			this.#mirror.delete(dst);
			if (dstPrev !== undefined) this.#mirror.set(dst, dstPrev);
			this.#mirror.set(src, entry);
			throw toError(err);
		}
	}

	async unlink(path: string): Promise<void> {
		const existed = this.#mirror.delete(path);
		await this.#client.unsafe(this.#q.delete, [path]);
		if (!existed) {
			throw enoent(path);
		}
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		await this.unlink(sessionPath);

		// Tool artifact bytes don't live in SQL (the file-backed
		// `ArtifactManager` keeps them on disk), but a draft sidecar may
		// have been written through `writeText` under the artifacts
		// directory prefix. Sweep those keys in one statement.
		const artifactsDir = sessionPath.slice(0, -6);
		const prefix = artifactsDir.endsWith("/") ? artifactsDir : `${artifactsDir}/`;

		const victims: string[] = [];
		for (const key of this.#mirror.keys()) {
			if (key.startsWith(prefix)) victims.push(key);
		}
		if (victims.length === 0) return;

		for (const key of victims) this.#mirror.delete(key);
		const likePattern = `${escapeLikeLiteral(prefix)}%`;
		try {
			await this.#client.unsafe(this.#q.deletePrefix, [likePattern]);
		} catch (err) {
			logger.warn("SQL session storage artifact sweep failed", {
				sessionPath,
				prefix,
				error: toError(err).message,
			});
			throw toError(err);
		}
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = new SqlSessionStorageWriter(this, path, options);
		this.#writers.add(writer);
		return writer;
	}

	// --- writer support -------------------------------------------------------

	_writerClosed(writer: SqlSessionStorageWriter): void {
		this.#writers.delete(writer);
	}

	_mirrorAppend(path: string, line: string): { content: string; mtimeMs: number } {
		const existing = this.#mirror.get(path);
		const content = existing ? existing.content + line : line;
		const mtimeMs = this.#allocMtimeMs();
		this.#mirror.set(path, { content, mtimeMs });
		return { content, mtimeMs };
	}

	_mirrorTruncate(path: string): void {
		this.#mirror.set(path, { content: "", mtimeMs: this.#allocMtimeMs() });
	}

	async _remoteTruncate(path: string): Promise<void> {
		const entry = this.#mirror.get(path);
		const mtimeMs = entry?.mtimeMs ?? this.#allocMtimeMs();
		await this.#upsertReplace(path, "", mtimeMs);
	}

	/**
	 * Append a chunk to the row at `path`, inserting if the row doesn't
	 * exist yet. Single round-trip via the dialect-specific `upsertAppend`.
	 */
	async _remoteAppend(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.upsertAppend, [path, line, mtimeMs]);
	}

	_attachPending(promise: Promise<void>): void {
		this.#trackPending(promise);
	}

	async #upsertReplace(path: string, content: string, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.upsertReplace, [path, content, mtimeMs]);
	}
}

class SqlSessionStorageWriter implements SessionStorageWriter {
	#storage: SqlSessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;
	#pendingChain: Promise<void> = Promise.resolve();

	constructor(
		storage: SqlSessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		if (flags === "w") {
			// Mirror `FileSessionStorageWriter`'s `flags: "w"` contract by
			// truncating both the mirror and the underlying row immediately.
			storage._mirrorTruncate(path);
			this.#enqueueRaw(() => storage._remoteTruncate(path));
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	#enqueueRaw(task: () => Promise<void>): Promise<void> {
		const next = this.#pendingChain.then(async () => {
			if (this.#error) throw this.#error;
			try {
				await task();
			} catch (err) {
				throw this.#recordError(err);
			}
		});
		this.#pendingChain = next.catch(() => {
			// Errors are recorded on `this.#error`; subsequent enqueues
			// throw from inside the wrapper above. The outer chain swallows
			// to avoid surfacing as an unhandled promise rejection.
		});
		this.#storage._attachPending(next);
		return next;
	}

	writeLineSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const { mtimeMs } = this.#storage._mirrorAppend(this.#path, line);
		this.#enqueueRaw(() => this.#storage._remoteAppend(this.#path, line, mtimeMs));
	}

	async writeLine(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const { mtimeMs } = this.#storage._mirrorAppend(this.#path, line);
		await this.#enqueueRaw(() => this.#storage._remoteAppend(this.#path, line, mtimeMs));
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
		await this.#enqueueRaw(async () => {});
		if (this.#error) throw this.#error;
	}

	async fsync(): Promise<void> {
		// `bun:sql` returns once the server has acknowledged the write;
		// flush() already drains every queued statement.
		await this.flush();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.flush();
		} finally {
			this.#storage._writerClosed(this);
		}
	}

	getError(): Error | undefined {
		return this.#error;
	}
}
