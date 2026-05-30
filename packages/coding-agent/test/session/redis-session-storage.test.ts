/**
 * Functional tests for {@link RedisSessionStorage}. Driven by a hand-rolled
 * fake Redis client so the suite runs without a live server.
 *
 * The harness mirrors only the surface the storage actually uses; it is *not*
 * a general-purpose mock. Each test exercises one contract:
 *
 * - the mirror keeps `existsSync`/`statSync`/`readTextSync`/`listFilesSync`
 *   coherent with `writeText`/`writer.writeLineSync`;
 * - `drain()` waits for fire-and-forget background writes;
 * - `deleteSessionWithArtifacts` removes both the JSONL key and any sidecar
 *   keys under the artifacts prefix;
 * - `refresh()` re-loads the keyspace, so a peer process's writes become
 *   visible after an explicit re-scan.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";

interface FakeRedisCall {
	method: string;
	args: unknown[];
}

interface FakeRedis extends RedisSessionStorageClient {
	calls: FakeRedisCall[];
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
	/** Override the next call to `method` to reject with `error`. */
	failNext(method: string, error: Error): void;
}

function createFakeRedis(): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();
	const calls: FakeRedisCall[] = [];
	const failures = new Map<string, Error[]>();

	const checkFailure = (method: string): void => {
		const queue = failures.get(method);
		if (!queue || queue.length === 0) return;
		throw queue.shift() as Error;
	};

	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args });
	};

	const getHash = (key: string): Map<string, string> => {
		let h = hashes.get(key);
		if (!h) {
			h = new Map();
			hashes.set(key, h);
		}
		return h;
	};

	const client: FakeRedis = {
		calls,
		strings,
		hashes,
		failNext(method: string, error: Error): void {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		async get(key) {
			record("get", [key]);
			checkFailure("get");
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async set(key, value) {
			record("set", [key, value]);
			checkFailure("set");
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			record("append", [key, value]);
			checkFailure("append");
			const current = strings.get(key) ?? "";
			const next = current + value;
			strings.set(key, next);
			return next.length;
		},
		async del(...keys) {
			record("del", keys);
			checkFailure("del");
			let deleted = 0;
			for (const k of keys) {
				if (strings.delete(k)) deleted += 1;
			}
			return deleted;
		},
		async rename(src, dst) {
			record("rename", [src, dst]);
			checkFailure("rename");
			if (!strings.has(src)) {
				throw new Error("ERR no such key");
			}
			strings.set(dst, strings.get(src) as string);
			strings.delete(src);
			return "OK";
		},
		async scan(cursor, ...rest) {
			record("scan", [cursor, ...rest]);
			checkFailure("scan");
			let pattern = "*";
			for (let i = 0; i < rest.length; i++) {
				if (String(rest[i]).toUpperCase() === "MATCH") {
					pattern = String(rest[i + 1] ?? "*");
				}
			}
			const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			const matches = Array.from(strings.keys()).filter(k => regex.test(k));
			return ["0", matches];
		},
		async hset(key, field, value) {
			record("hset", [key, field, value]);
			checkFailure("hset");
			getHash(key).set(field, value);
			return 1;
		},
		async hgetall(key) {
			record("hgetall", [key]);
			checkFailure("hgetall");
			const h = hashes.get(key);
			if (!h) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of h) out[k] = v;
			return out;
		},
		async hdel(key, ...fields) {
			record("hdel", [key, ...fields]);
			checkFailure("hdel");
			const h = hashes.get(key);
			if (!h) return 0;
			let n = 0;
			for (const f of fields) {
				if (h.delete(f)) n += 1;
			}
			return n;
		},
	};

	return client;
}

describe("RedisSessionStorage", () => {
	let redis: FakeRedis;

	beforeEach(() => {
		redis = createFakeRedis();
	});

	it("mirrors writeText into Redis and exposes content via sync reads", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.readTextSync("/sessions/p/a.jsonl")).toBe("line1\nline2\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
	});

	it("listFilesSync returns only direct children matching the glob", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		const jsonl = storage.listFilesSync("/dir", "*.jsonl").sort();
		expect(jsonl).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);

		const bak = storage.listFilesSync("/dir", "*.bak");
		expect(bak).toEqual(["/dir/note.bak"]);
	});

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");

		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	});

	it("writer.writeLineSync appends to Redis after drain", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		writer.writeLineSync('{"type":"session"}\n');
		writer.writeLineSync('{"type":"message"}\n');

		// Mirror reflects the writes synchronously.
		expect(storage.readTextSync("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		// Redis has not necessarily caught up yet — drain to force.
		await storage.drain();
		expect(redis.strings.get("omp:sessions:file:/sessions/p/session.jsonl")).toBe(
			'{"type":"session"}\n{"type":"message"}\n',
		);

		await writer.close();
	});

	it("flags='w' truncates both mirror and Redis", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		writer.writeLineSync("fresh\n");
		await writer.close();

		expect(storage.readTextSync("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/keep.jsonl")).toBe("fresh\n");
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");
		redis.failNext("append", new Error("redis exploded"));
		writer.writeLineSync("doomed\n");

		await expect(storage.drain()).rejects.toThrow("redis exploded");
		expect(writer.getError()?.message).toBe("redis exploded");
	});

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1.jsonl")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1/draft.txt")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/other.jsonl")).toBe(true);
	});

	it("rename moves content and meta atomically inside the mirror", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(storage.readTextSync("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);
		expect(redis.strings.get("omp:sessions:file:/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(redis.strings.has("omp:sessions:file:/sessions/p/orig.jsonl")).toBe(false);
	});

	it("rename rolls back the mirror when Redis RENAME fails", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "keep\n");
		redis.failNext("rename", new Error("ERR redis rejected rename"));

		await expect(storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl")).rejects.toThrow(
			"ERR redis rejected rename",
		);

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.existsSync("/sessions/p/b.jsonl")).toBe(false);
	});

	it("refresh() reloads the mirror from Redis after out-of-band writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		// Simulate a peer process writing directly to Redis.
		redis.strings.set("omp:sessions:file:/peer/x.jsonl", "from peer\n");
		const peerHash = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
		peerHash.set("/peer/x.jsonl", String(Date.now() + 5_000));
		redis.hashes.set("omp:sessions:meta", peerHash);

		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);
		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(storage.readTextSync("/peer/x.jsonl")).toBe("from peer\n");
	});

	it("readTextPrefix returns at most maxBytes from the head", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect(await storage.readTextPrefix("/sessions/p/big.jsonl", 4)).toBe("abcd");
		expect(await storage.readTextPrefix("/sessions/p/big.jsonl", 100)).toBe("abcdefghij");
		expect(await storage.readTextPrefix("/sessions/p/big.jsonl", 0)).toBe("");
	});

	it("custom prefix isolates keyspaces", async () => {
		const storage = await RedisSessionStorage.create({ client: redis, prefix: "proj-a:" });
		await storage.writeText("/sessions/x.jsonl", "hello\n");
		expect(redis.strings.has("proj-a:file:/sessions/x.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/x.jsonl")).toBe(false);
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
