import { logger, toError } from "@oh-my-pi/pi-utils";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";

/**
 * Minimal subset of the `bun:redis` `RedisClient` surface used by
 * {@link RedisSessionStorage}. Keeping the contract narrow (and accepting any
 * client that conforms) lets callers swap in test doubles or shared clients
 * without dragging the entire Bun typings into this module.
 */
export interface RedisSessionStorageClient {
	get(key: string): Promise<string | null>;
	getrange(key: string, start: number, end: number): Promise<string>;
	strlen(key: string): Promise<number>;
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
	 * Maximum number of keys returned per SCAN batch when warming the metadata index.
	 * Default 500.
	 */
	scanCount?: number;
}

const DEFAULT_PREFIX = "omp:sessions:";
const DEFAULT_SCAN_COUNT = 500;

/**
 * Redis-backed implementation of {@link SessionStorage}. Each session JSONL
 * file maps to a Redis STRING key, with per-key metadata (mtime) tracked in a
 * single sibling HASH. This process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory so synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls remain available without mirroring full content.
 */
export class RedisSessionStorage extends IndexedSessionStorage {
	/**
	 * Warm the metadata index with every existing session key under the configured
	 * prefix and return the ready-to-use storage. Must be awaited before passing
	 * the storage into `SessionManager.create()` so synchronous lookups (session
	 * resume, recent sessions, EPERM-backup recovery) see the existing keyspace.
	 */
	static async create(options: RedisSessionStorageOptions): Promise<RedisSessionStorage> {
		const storage = new RedisSessionStorage(new RedisSessionStorageBackend(options));
		await storage.initialize();
		return storage;
	}
}

class RedisSessionStorageBackend implements SessionStorageBackend {
	readonly #client: RedisSessionStorageClient;
	readonly #prefix: string;
	readonly #scanCount: number;

	constructor(options: RedisSessionStorageOptions) {
		this.#client = options.client;
		this.#prefix = options.prefix ?? DEFAULT_PREFIX;
		this.#scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
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

		const fallbackMtimeMs = Date.now();
		return Promise.all(
			Array.from(seen, async key => {
				const path = key.slice(filePrefix.length);
				const size = await this.#client.strlen(key);
				const rawMtime = meta[path];
				const parsedMtime = rawMtime === undefined ? Number.NaN : Number(rawMtime);
				return {
					path,
					size,
					mtimeMs: Number.isFinite(parsedMtime) ? parsedMtime : fallbackMtimeMs,
				};
			}),
		);
	}

	readFull(path: string): Promise<string | null> {
		return this.#client.get(this.#fileKey(path));
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const key = this.#fileKey(path);
		const head = prefixBytes > 0 ? this.#client.getrange(key, 0, prefixBytes - 1) : Promise.resolve("");
		const tail = suffixBytes > 0 ? this.#client.getrange(key, -suffixBytes, -1) : Promise.resolve("");
		return Promise.all([head, tail]);
	}

	async writeFull(path: string, content: string, mtimeMs: number): Promise<void> {
		await this.#client.set(this.#fileKey(path), content);
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.append(this.#fileKey(path), line);
		await this.#client.hset(this.#metaKey(), path, String(mtimeMs));
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.#client.del(...paths.map(path => this.#fileKey(path)));
		await this.#client.hdel(this.#metaKey(), ...paths);
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		await this.#client.rename(this.#fileKey(src), this.#fileKey(dst));
		try {
			await this.#client.hdel(this.#metaKey(), src);
			await this.#client.hset(this.#metaKey(), dst, String(mtimeMs));
		} catch (err) {
			logger.warn("Redis session storage meta rename failed", {
				src,
				dst,
				error: toError(err).message,
			});
		}
	}

	#fileKey(path: string): string {
		return `${this.#prefix}file:${path}`;
	}

	#metaKey(): string {
		return `${this.#prefix}meta`;
	}
}
