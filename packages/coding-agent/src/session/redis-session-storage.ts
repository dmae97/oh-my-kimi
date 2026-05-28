import { logger, toError } from "@oh-my-pi/pi-utils";
import type { SessionStorage, SessionStorageStat, SessionStorageWriter } from "./session-storage";

/**
 * Minimal subset of the `bun:redis` `RedisClient` surface used by
 * {@link RedisSessionStorage}. Keeping the contract narrow (and accepting any
 * client that conforms) lets callers swap in test doubles or shared clients
 * without dragging the entire Bun typings into this module.
 */
export interface RedisSessionStorageClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<unknown>;
	append(key: string, value: string): Promise<number>;
	del(...keys: string[]): Promise<number>;
	rename(src: string, dst: string): Promise<unknown>;
	scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
	hset(key: string, field: string, value: string): Promise<unknown>;
	hgetall(key: string): Promise<Record<string, string>>;
	hdel(key: string, ...fields: string[]): Promise<unknown>;
}

export interface RedisSessionStorageOptions {
	/** A connected `bun:redis` RedisClient (or any compatible adapter). */
	client: RedisSessionStorageClient;
	/**
	 * Key prefix applied to every Redis key this storage owns. Default `omp:sessions:`.
	 * Trailing colon is preserved verbatim — set to a project-scoped prefix to share
	 * one Redis instance between multiple agents.
	 */
	prefix?: string;
	/**
	 * Maximum number of keys returned per SCAN batch when warming the mirror.
	 * Default 500.
	 */
	scanCount?: number;
}

interface MirrorEntry {
	content: string;
	mtimeMs: number;
}

const DEFAULT_PREFIX = "omp:sessions:";
const DEFAULT_SCAN_COUNT = 500;

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

/**
 * Redis-backed implementation of {@link SessionStorage}. Each session JSONL
 * file maps to a Redis STRING key, with per-key metadata (mtime) tracked in a
 * single sibling HASH. An in-memory mirror is loaded on construction so the
 * interface's synchronous methods (`existsSync`, `statSync`, `listFilesSync`,
 * `readTextSync`, `writeTextSync`) keep their contracts — Bun's Redis client
 * is async only, and the persist hot path (`writer.writeLineSync`) cannot
 * wait on a network round-trip.
 *
 * Trade-offs vs `FileSessionStorage`:
 * - Mirror state is process-local. Two processes writing the same session key
 *   will diverge until one of them reloads via {@link refresh}. This matches
 *   `FileSessionStorage`'s existing single-writer assumption.
 * - `writeLineSync` updates the mirror synchronously and queues an async
 *   `APPEND`. The promise is awaited by `flush()` / `close()` / {@link drain}.
 *   A SIGKILL landing between the sync mirror update and the network round
 *   trip loses the last line; the file-backed implementation survives that
 *   window because bytes are handed to the kernel page cache before
 *   returning.
 * - Blobs (image data) and tool artifact files still live on disk via
 *   `BlobStore` / `ArtifactManager`. Those are out of scope for this storage.
 */
export class RedisSessionStorage implements SessionStorage {
	readonly #client: RedisSessionStorageClient;
	readonly #prefix: string;
	readonly #scanCount: number;
	readonly #mirror = new Map<string, MirrorEntry>();
	readonly #writers = new Set<RedisSessionStorageWriter>();
	#nextMtimeMs = 0;
	#pendingTail: Promise<void> = Promise.resolve();

	private constructor(options: RedisSessionStorageOptions) {
		this.#client = options.client;
		this.#prefix = options.prefix ?? DEFAULT_PREFIX;
		this.#scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
	}

	/**
	 * Warm the in-memory mirror with every existing session key under the
	 * configured prefix and return the ready-to-use storage. Must be awaited
	 * before passing the storage into `SessionManager.create()` so synchronous
	 * lookups (session resume, recent sessions, EPERM-backup recovery) see
	 * the existing keyspace.
	 */
	static async create(options: RedisSessionStorageOptions): Promise<RedisSessionStorage> {
		const storage = new RedisSessionStorage(options);
		await storage.refresh();
		return storage;
	}

	/**
	 * Re-scan Redis and replace the mirror's contents. Call this from a
	 * different process that took over a session keyspace, or after an
	 * out-of-band write made by another agent.
	 */
	async refresh(): Promise<void> {
		this.#mirror.clear();
		const filePrefix = this.#fileKey("");
		const metaRaw = await this.#client.hgetall(this.#metaKey());
		const meta: Record<string, string> = metaRaw ?? {};

		const seen = new Set<string>();
		let cursor = "0";
		do {
			const [next, batch] = await this.#client.scan(
				cursor,
				"MATCH",
				`${filePrefix}*`,
				"COUNT",
				String(this.#scanCount),
			);
			cursor = next;
			for (const key of batch) seen.add(key);
		} while (cursor !== "0");

		await Promise.all(
			Array.from(seen, async key => {
				const path = key.slice(filePrefix.length);
				const content = await this.#client.get(key);
				if (content === null) return;
				const mtimeRaw = meta[path];
				const mtimeMs = mtimeRaw ? Number(mtimeRaw) : Date.now();
				this.#mirror.set(path, { content, mtimeMs });
				if (mtimeMs > this.#nextMtimeMs) this.#nextMtimeMs = mtimeMs;
			}),
		);
	}

	/**
	 * Resolve once every pending background write (issued via `writeTextSync`
	 * or `writer.writeLineSync`) has been acknowledged by Redis. Throws if any
	 * background write failed since the last drain.
	 *
	 * Call this on graceful shutdown to avoid losing the last unflushed line.
	 * The session-manager's own `flush()` / `close()` already drain through
	 * the writer chain — this method exists for callers (test harnesses,
	 * subprocess-style consumers) that bypass the writer.
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

	#fileKey(path: string): string {
		return `${this.#prefix}file:${path}`;
	}

	#metaKey(): string {
		return `${this.#prefix}meta`;
	}

	/**
	 * Allocate a strictly monotonic mtime. Multiple writes within the same
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
		// `Promise.all` rejects if either input rejects, which is exactly
		// what we want for `drain()`. The follow-up `.catch(() => {})` is
		// attached only to silence the unhandled-rejection signal on the
		// shared tail — `drain()` keeps its own handler chain and still
		// observes the original error, because rejection delivery is
		// per-handler-chain, not per-promise.
		this.#pendingTail = Promise.all([this.#pendingTail, promise]).then(() => {});
		this.#pendingTail.catch(() => {});
	}

	// --- sync surface ---------------------------------------------------------

	ensureDirSync(_dir: string): void {
		// Redis is flat: directories are derived from key prefixes.
	}

	existsSync(path: string): boolean {
		return this.#mirror.has(path);
	}

	writeTextSync(path: string, content: string): void {
		const mtimeMs = this.#allocMtimeMs();
		this.#mirror.set(path, { content, mtimeMs });
		this.#trackPending(this.#writeRemote(path, content, mtimeMs));
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
		// Mirror is the source of truth; checking Redis would only diverge
		// when a peer process mutated the key, which is outside the
		// storage's contract (see class JSDoc).
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
		// `entry.content` is a JS string (UTF-16 code units), but the prefix
		// contract is byte-oriented. Encode to UTF-8, slice, then decode —
		// matching `peekFile`'s behaviour for the file-backed storage.
		const bytes = Buffer.from(entry.content, "utf-8");
		const slice = bytes.subarray(0, Math.min(maxBytes, bytes.byteLength));
		return slice.toString("utf-8");
	}

	async writeText(path: string, content: string): Promise<void> {
		const mtimeMs = this.#allocMtimeMs();
		this.#mirror.set(path, { content, mtimeMs });
		await this.#writeRemote(path, content, mtimeMs);
	}

	async rename(src: string, dst: string): Promise<void> {
		const entry = this.#mirror.get(src);
		if (!entry) throw enoent(src);
		// Update the mirror first so a synchronous existsSync() right after
		// the await resolves consistently. If RENAME fails the mirror is
		// rolled back below.
		this.#mirror.delete(src);
		this.#mirror.set(dst, entry);

		try {
			await this.#client.rename(this.#fileKey(src), this.#fileKey(dst));
		} catch (err) {
			this.#mirror.delete(dst);
			this.#mirror.set(src, entry);
			throw toError(err);
		}

		// Move the mtime hash entry too. Failures here cause meta drift but
		// the mirror cache keeps statSync accurate, so log and continue.
		try {
			await this.#client.hdel(this.#metaKey(), src);
			await this.#client.hset(this.#metaKey(), dst, String(entry.mtimeMs));
		} catch (err) {
			logger.warn("Redis session storage meta rename failed", {
				src,
				dst,
				error: toError(err).message,
			});
		}
	}

	async unlink(path: string): Promise<void> {
		const existed = this.#mirror.delete(path);
		await this.#client.del(this.#fileKey(path));
		await this.#client.hdel(this.#metaKey(), path);
		if (!existed) {
			throw enoent(path);
		}
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		await this.unlink(sessionPath);

		// Mirror artifacts live under `<sessionPath without .jsonl>/...`. The
		// Redis storage doesn't actually persist tool artifact bytes — those
		// stay on disk via `ArtifactManager` — but a draft sidecar may have
		// been written through `writeText`. Sweep any keys under that prefix.
		const artifactsDir = sessionPath.slice(0, -6);
		const prefix = artifactsDir.endsWith("/") ? artifactsDir : `${artifactsDir}/`;
		const victims: string[] = [];
		for (const key of this.#mirror.keys()) {
			if (key.startsWith(prefix)) victims.push(key);
		}
		if (victims.length === 0) return;

		for (const key of victims) this.#mirror.delete(key);
		await this.#client.del(...victims.map(v => this.#fileKey(v)));
		await this.#client.hdel(this.#metaKey(), ...victims);
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = new RedisSessionStorageWriter(this, path, options);
		this.#writers.add(writer);
		return writer;
	}

	// --- writer support -------------------------------------------------------

	_writerClosed(writer: RedisSessionStorageWriter): void {
		this.#writers.delete(writer);
	}

	/** Mirror-only mutation, no Redis call. Used by writers to update local state synchronously. */
	_mirrorAppend(path: string, line: string): void {
		const existing = this.#mirror.get(path);
		const content = existing ? existing.content + line : line;
		this.#mirror.set(path, { content, mtimeMs: this.#allocMtimeMs() });
	}

	/** Mirror-only mutation, no Redis call. Used by writers opened with `flags: "w"` to truncate. */
	_mirrorTruncate(path: string): void {
		this.#mirror.set(path, { content: "", mtimeMs: this.#allocMtimeMs() });
	}

	async _remoteTruncate(path: string): Promise<void> {
		const entry = this.#mirror.get(path);
		const mtimeMs = entry?.mtimeMs ?? Date.now();
		await this.#client.set(this.#fileKey(path), "");
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
	}

	async _remoteAppend(path: string, line: string): Promise<void> {
		await this.#client.append(this.#fileKey(path), line);
		const entry = this.#mirror.get(path);
		if (entry) {
			await this.#client.hset(this.#metaKey(), path, String(entry.mtimeMs));
		}
	}

	/** Record a writer's pending promise on the storage-level tail so `drain()` waits for it. */
	_attachPending(promise: Promise<void>): void {
		this.#trackPending(promise);
	}

	async #writeRemote(path: string, content: string, mtimeMs: number): Promise<void> {
		await this.#client.set(this.#fileKey(path), content);
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
	}
}

class RedisSessionStorageWriter implements SessionStorageWriter {
	#storage: RedisSessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;
	#pendingChain: Promise<void> = Promise.resolve();

	constructor(
		storage: RedisSessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		if (flags === "w") {
			// "w" mirrors FileSessionStorageWriter passing `"w"` to
			// `fs.openSync`: start from empty content. Materialize the
			// truncate in the mirror synchronously so an immediate reader
			// can't observe stale content, then queue the remote SET.
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
		// Storage-level drain() waits for every writer's pending work too.
		this.#storage._attachPending(next);
		return next;
	}

	writeLineSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		this.#storage._mirrorAppend(this.#path, line);
		this.#enqueueRaw(() => this.#storage._remoteAppend(this.#path, line));
	}

	async writeLine(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		this.#storage._mirrorAppend(this.#path, line);
		await this.#enqueueRaw(() => this.#storage._remoteAppend(this.#path, line));
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
		await this.#enqueueRaw(async () => {});
		if (this.#error) throw this.#error;
	}

	async fsync(): Promise<void> {
		// Bun's `RedisClient` has no fsync equivalent; APPEND/SET return only
		// after the server has acknowledged the write. `flush()` already
		// awaits that ack, so this collapses into a drain.
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
