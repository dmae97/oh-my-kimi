/**
 * SQLite-backed cache for rendered `github` issue/PR view output, plus a
 * generic cache-aware wrapper that the tool ops and the `issue://`/`pr://`
 * protocol handlers share.
 *
 * Storage:
 *   One process-wide connection opens lazily on first hit and stays open. All
 *   helpers swallow open/IO failures and degrade to "no cache" so a corrupt or
 *   unreadable DB never blocks a `gh` call.
 *
 * TTL:
 *   Soft TTL → return cached row directly.
 *   Past soft TTL but within hard TTL → return cached row AND schedule a
 *     background refresh (errors logged, never thrown).
 *   Past hard TTL → treat as miss and fetch fresh.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGithubCacheDbPath, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

// ────────────────────────────────────────────────────────────────────────────
// Storage layer
// ────────────────────────────────────────────────────────────────────────────

export type CacheKind = "issue" | "pr";

export interface CachedView<T = unknown> {
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	fetchedAt: number;
	payload: T;
	rendered: string;
	sourceUrl: string | undefined;
}

interface Row {
	repo: string;
	kind: CacheKind;
	number: number;
	include_comments: number;
	fetched_at: number;
	payload: string;
	rendered: string;
	source_url: string | null;
}

const DEFAULT_SOFT_TTL_SEC = 300; // 5 minutes
const DEFAULT_HARD_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

let cachedDb: Database | null = null;
let openAttempted = false;

function ensureParentDir(filePath: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
	} catch (err) {
		logger.debug("github cache: failed to create parent dir", { err: String(err) });
	}
}

export function openDb(): Database | null {
	if (cachedDb) return cachedDb;
	if (openAttempted) return null;
	openAttempted = true;
	try {
		const dbPath = getGithubCacheDbPath();
		ensureParentDir(dbPath);
		const db = new Database(dbPath);
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS github_view_cache (
				repo             TEXT    NOT NULL,
				kind             TEXT    NOT NULL CHECK (kind IN ('issue','pr')),
				number           INTEGER NOT NULL,
				include_comments INTEGER NOT NULL,
				fetched_at       INTEGER NOT NULL,
				payload          TEXT    NOT NULL,
				rendered         TEXT    NOT NULL,
				source_url       TEXT,
				PRIMARY KEY (repo, kind, number, include_comments)
			);
			CREATE INDEX IF NOT EXISTS idx_github_view_cache_fetched ON github_view_cache(fetched_at);
			PRAGMA user_version = 1;
		`);
		cachedDb = db;
		// One-shot eviction on open. The default `DEFAULT_HARD_TTL_SEC` is a
		// coarse backstop only — when settings load with a stricter
		// `github.cache.hardTtlSec`, the per-lookup sweep in `getOrFetchView()`
		// enforces the configured retention against the on-disk file.
		evictExpired(db, DEFAULT_HARD_TTL_SEC * 1000);
		return db;
	} catch (err) {
		logger.warn("github cache: failed to open DB; cache disabled", { err: String(err) });
		return null;
	}
}

function evictExpired(db: Database, hardTtlMs: number): void {
	try {
		const cutoff = Date.now() - hardTtlMs;
		db.prepare("DELETE FROM github_view_cache WHERE fetched_at < ?").run(cutoff);
	} catch (err) {
		logger.debug("github cache: eviction failed", { err: String(err) });
	}
}

/**
 * Throttle for the per-lookup configured-TTL sweep. We don't want every
 * cached read to issue a DELETE; once per `SWEEP_INTERVAL_MS` is enough to
 * cap the on-disk exposure window at roughly `hardTtlMs + SWEEP_INTERVAL_MS`.
 */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

function sweepIfDue(hardTtlMs: number): void {
	const now = Date.now();
	if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
	const db = openDb();
	if (!db) return;
	lastSweepAt = now;
	evictExpired(db, hardTtlMs);
}

function normalizeRepo(repo: string): string {
	return repo.toLowerCase();
}

export function getCached<T = unknown>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
): CachedView<T> | null {
	const db = openDb();
	if (!db) return null;
	try {
		const row = db
			.prepare(
				"SELECT repo, kind, number, include_comments, fetched_at, payload, rendered, source_url FROM github_view_cache WHERE repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			)
			.get(normalizeRepo(repo), kind, number, includeComments ? 1 : 0) as Row | undefined;
		if (!row) return null;
		let payload: T;
		try {
			payload = JSON.parse(row.payload) as T;
		} catch (err) {
			logger.debug("github cache: corrupt payload row, ignoring", { err: String(err), repo, kind, number });
			return null;
		}
		return {
			repo: row.repo,
			kind: row.kind,
			number: row.number,
			includeComments: row.include_comments === 1,
			fetchedAt: row.fetched_at,
			payload,
			rendered: row.rendered,
			sourceUrl: row.source_url ?? undefined,
		};
	} catch (err) {
		logger.debug("github cache: read failed", { err: String(err) });
		return null;
	}
}

export interface PutCachedInput<T = unknown> {
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	payload: T;
	rendered: string;
	sourceUrl?: string;
	fetchedAt?: number;
}

export function putCached<T = unknown>(input: PutCachedInput<T>): void {
	const db = openDb();
	if (!db) return;
	try {
		const fetchedAt = input.fetchedAt ?? Date.now();
		const payloadJson = JSON.stringify(input.payload);
		db.prepare(
			"INSERT OR REPLACE INTO github_view_cache (repo, kind, number, include_comments, fetched_at, payload, rendered, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			normalizeRepo(input.repo),
			input.kind,
			input.number,
			input.includeComments ? 1 : 0,
			fetchedAt,
			payloadJson,
			input.rendered,
			input.sourceUrl ?? null,
		);
	} catch (err) {
		logger.debug("github cache: write failed", { err: String(err) });
	}
}

/** Drop a specific cache entry. */
export function invalidate(repo: string, kind: CacheKind, number: number, includeComments?: boolean): void {
	const db = openDb();
	if (!db) return;
	try {
		if (includeComments === undefined) {
			db.prepare("DELETE FROM github_view_cache WHERE repo = ? AND kind = ? AND number = ?").run(
				normalizeRepo(repo),
				kind,
				number,
			);
		} else {
			db.prepare(
				"DELETE FROM github_view_cache WHERE repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			).run(normalizeRepo(repo), kind, number, includeComments ? 1 : 0);
		}
	} catch (err) {
		logger.debug("github cache: invalidate failed", { err: String(err) });
	}
}

/** Drop every cached row. Test helper. */
export function clearAll(): void {
	const db = openDb();
	if (!db) return;
	try {
		db.prepare("DELETE FROM github_view_cache").run();
	} catch (err) {
		logger.debug("github cache: clear failed", { err: String(err) });
	}
}

/**
 * Test/maintenance helper. Closes and forgets the cached connection so the
 * next access reopens against (possibly) a different DB path.
 */
export function resetForTests(): void {
	if (cachedDb) {
		try {
			cachedDb.close();
		} catch {
			// Closing failures are non-fatal.
		}
	}
	cachedDb = null;
	openAttempted = false;
	lastSweepAt = 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache-aware lookup wrapper
// ────────────────────────────────────────────────────────────────────────────

export interface FreshResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
}

export interface CacheLookupOptions<T> {
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	fetchFresh: () => Promise<FreshResult<T>>;
	settings?: Settings | undefined;
	now?: number;
}

export type CacheStatus = "miss" | "fresh" | "stale" | "disabled";

export interface CacheLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

function readNumberSetting(settings: Settings | undefined, key: string, fallback: number): number {
	if (!settings) return fallback;
	try {
		const value = (settings as unknown as { get(k: string): unknown }).get(key);
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	} catch {
		// Unknown setting paths fall through to default; settings may be a
		// stripped test stub that doesn't expose every key.
	}
	return fallback;
}

function readBooleanSetting(settings: Settings | undefined, key: string, fallback: boolean): boolean {
	if (!settings) return fallback;
	try {
		const value = (settings as unknown as { get(k: string): unknown }).get(key);
		if (typeof value === "boolean") return value;
	} catch {
		// Same fallback rationale as readNumberSetting.
	}
	return fallback;
}

export interface CacheTtl {
	softMs: number;
	hardMs: number;
	enabled: boolean;
}

export function resolveCacheTtl(settings?: Settings): CacheTtl {
	const softSec = readNumberSetting(settings, "github.cache.softTtlSec", DEFAULT_SOFT_TTL_SEC);
	const hardSec = readNumberSetting(settings, "github.cache.hardTtlSec", DEFAULT_HARD_TTL_SEC);
	const enabled = readBooleanSetting(settings, "github.cache.enabled", true);
	return {
		softMs: Math.max(0, softSec) * 1000,
		hardMs: Math.max(0, hardSec) * 1000,
		enabled,
	};
}

function storeResult<T>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	result: FreshResult<T>,
	fetchedAt: number,
): void {
	putCached<T>({
		repo,
		kind,
		number,
		includeComments,
		payload: result.payload,
		rendered: result.rendered,
		sourceUrl: result.sourceUrl,
		fetchedAt,
	});
}

function scheduleBackgroundRefresh<T>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	fetchFresh: () => Promise<FreshResult<T>>,
): void {
	queueMicrotask(() => {
		const promise = fetchFresh();
		promise
			.then(fresh => {
				storeResult(repo, kind, number, includeComments, fresh, Date.now());
			})
			.catch(err => {
				logger.debug("github cache: background refresh failed", {
					err: String(err),
					repo,
					kind,
					number,
				});
			});
	});
}

export async function getOrFetchView<T>(options: CacheLookupOptions<T>): Promise<CacheLookupResult<T>> {
	const ttl = resolveCacheTtl(options.settings);
	const now = options.now ?? Date.now();

	if (!ttl.enabled) {
		const fresh = await options.fetchFresh();
		return { ...fresh, status: "disabled", fetchedAt: now };
	}

	// Enforce the *configured* hard TTL against on-disk rows. This is what
	// makes `github.cache.hardTtlSec` a real retention cap rather than a soft
	// suggestion the next `openDb()` call eventually honors.
	sweepIfDue(ttl.hardMs);

	const cached: CachedView<T> | null = getCached<T>(
		options.repo,
		options.kind,
		options.number,
		options.includeComments,
	);

	if (cached) {
		const age = now - cached.fetchedAt;
		if (age <= ttl.softMs) {
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "fresh",
				fetchedAt: cached.fetchedAt,
			};
		}
		if (age <= ttl.hardMs) {
			scheduleBackgroundRefresh(
				options.repo,
				options.kind,
				options.number,
				options.includeComments,
				options.fetchFresh,
			);
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "stale",
				fetchedAt: cached.fetchedAt,
			};
		}
		// Past hard TTL: drop the row eagerly so the on-disk exposure window
		// is bounded even if `fetchFresh()` then fails (network down, gh
		// auth lapse, etc.) and we never get to overwrite it.
		invalidate(options.repo, options.kind, options.number, options.includeComments);
	}

	const fresh = await options.fetchFresh();
	const fetchedAt = Date.now();
	storeResult(options.repo, options.kind, options.number, options.includeComments, fresh, fetchedAt);
	return { ...fresh, status: "miss", fetchedAt };
}

/**
 * Human-friendly freshness note for protocol-handler `notes[]` rendering.
 */
export function formatFreshnessNote(status: CacheStatus, fetchedAtMs: number, now: number = Date.now()): string {
	if (status === "miss") return "Fetched live";
	if (status === "disabled") return "Cache disabled; fetched live";
	const ageSec = Math.max(0, Math.round((now - fetchedAtMs) / 1000));
	const human =
		ageSec < 60
			? `${ageSec}s ago`
			: ageSec < 3600
				? `${Math.round(ageSec / 60)}m ago`
				: `${Math.round(ageSec / 3600)}h ago`;
	if (status === "stale") return `Cached: ${human} (refreshing in background)`;
	return `Cached: ${human}`;
}
