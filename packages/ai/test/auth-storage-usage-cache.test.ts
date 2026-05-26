/**
 * Tests for the new usage-cache contracts introduced after the broker
 * migration surfaced Anthropic per-IP rate limits:
 *
 *   1. Per-credential cache stores the last successful report; failures
 *      DON'T overwrite a stale-but-good entry with null.
 *   2. With a stale-but-good entry, a failure serves the previous value
 *      (cached for a short cool-down) instead of dropping the credential
 *      from the report.
 *   3. Without a previous value, a failure returns null and DOES NOT cache —
 *      the next poll retries on the next request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "../src/auth-storage";
import type { UsageReport } from "../src/usage";
import * as claudeUsage from "../src/usage/claude";

function anthropicReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(r => r.provider === "anthropic");
}

/**
 * Force every cache entry to look stale to AuthStorage WITHOUT dropping the
 * value. The cache layer is two-tier: the store-level `expiresAtSec` controls
 * whether `getCache` returns anything at all, and the JSON payload's own
 * `expiresAt` is what AuthStorage compares against `Date.now()` to decide if
 * the entry is fresh. Mutating only the inner expiresAt simulates time
 * passing while keeping the last-good value reachable for the failure path.
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			parsed.expiresAt = 1; // positive but already in the past (epoch ms)
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
}

/**
 * Minimal in-memory `AuthCredentialStore` exposing the cache so we can
 * assert what AuthStorage writes to it during usage fetches.
 */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number, email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function makeReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: account, accountId: `account-${account}` },
	};
}

describe("AuthStorage usage cache: last-good failure fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		// Restrict the resolver to anthropic. Without this, AuthStorage enumerates
		// every default provider and — for any provider whose `supports()` accepts
		// the matching `*_API_KEY` env var present on the test host — fans out a
		// real network fetch per poll. 3 polls × N real fetches blows past the 5s
		// test budget intermittently.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("caches a successful report and replays it on a second poll", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1);
		// Cache hit — provider was NOT called a second time.
		expect(calls).toBe(1);
	});

	it("does NOT cache a failure when no previous good value exists — retries next poll", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		const second = anthropicReports(await storage.fetchUsageReports());
		// No previous value → no cache write → retry on next poll.
		expect(calls).toBe(2);
		expect(second).toHaveLength(0);
	});

	it("serves last-good value through a failure cycle", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) return goldReport;
			return null;
		});

		// First poll: real fetch → cached.
		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Force every cached entry to expire so the next poll refetches.
		// Bun's `bun:test` doesn't ship setSystemTime, so we manipulate the
		// observable store cache directly — equivalent to advancing time past
		// the success TTL.
		expireCachePayloads(store);

		// Second poll: cache expired → refetch → provider returns null →
		// AuthStorage falls back to last-good and the report stays populated.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(second).toHaveLength(1);
		// The fallback value must be the SAME report (not a synthetic empty one).
		expect(second?.[0]?.limits[0]?.amount.used).toBe(42);
	});

	it("re-attempts the failing credential after the cool-down expires", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			// Succeed on attempt 1, fail on 2, succeed on 3.
			if (calls === 2) return null;
			return goldReport;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Expire success cache → poll 2 fetches and 429s → cool-down written.
		expireCachePayloads(store);
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(second).toHaveLength(1); // last-good fallback
		expect(calls).toBe(2);

		// Expire the cool-down → poll 3 refetches → success.
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(third).toHaveLength(1);
		expect(calls).toBe(3);
	});
});

describe("AuthStorage usage cache: jitter", () => {
	it("writes per-credential cache TTLs with ±25% jitter so refreshes decorrelate", async () => {
		const store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
		try {
			const goldA = makeReport("a@example.com");
			const goldB = makeReport("b@example.com");
			vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
				return params.credential.email === "a@example.com" ? goldA : goldB;
			});

			await storage.fetchUsageReports();

			// The store-level TTL is bumped to the 24h durable-retention floor so
			// `getStale` can recover last-good values; the freshness TTL we actually
			// jitter lives in the JSON payload. Read that, not the store TTL.
			const freshExpiries: number[] = [];
			for (const entry of store.cache.values()) {
				if (entry.value.length === 0) continue;
				const parsed = JSON.parse(entry.value);
				if (typeof parsed?.expiresAt === "number") freshExpiries.push(parsed.expiresAt);
			}
			expect(freshExpiries.length).toBeGreaterThanOrEqual(2);
			const now = Date.now();
			for (const expiry of freshExpiries) {
				const delta = expiry - now;
				expect(delta).toBeGreaterThan(3.5 * 60_000);
				expect(delta).toBeLessThan(6.5 * 60_000);
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: terminal refresh failure", () => {
	// Regression: a revoked refresh token used to fail the in-line OAuth refresh
	// inside the usage probe, get silently swallowed, then trigger the upstream
	// 401 → null → last-good fallback chain. The credential was therefore never
	// removed from the candidate set and the /usage TUI kept rendering yesterday's
	// report — including its now-elapsed `resetsAt`, which the renderer printed
	// as e.g. `(-612090ms)`. The fix CAS-disables the row on a definitive refresh
	// failure and clears the cache, so the credential drops out cleanly.
	it("disables credential and suppresses last-good when OAuth refresh fails with invalid_grant", async () => {
		// Row whose access token has just expired — within the 60s refresh skew so
		// the usage probe is forced to refresh before issuing the upstream call.
		const row = oauthRow(1, "a@example.com");
		(row.credential as { expires: number }).expires = Date.now() - 1000;
		const rows = [row];

		// `makeStore` returns `false` from `tryDisableAuthCredentialIfMatches`,
		// which would short-circuit our disable. Use a local store that actually
		// performs the soft-delete so we can observe the AuthStorage-side effects.
		const cache = new Map<string, CacheEntry>();
		let disableCalls = 0;
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(r => !r.disabledCause),
			updateAuthCredential() {},
			deleteAuthCredential(id: number, cause: string) {
				const target = rows.find(r => r.id === id);
				if (target) target.disabledCause = cause;
			},
			tryDisableAuthCredentialIfMatches(id: number, _data: string, cause: string) {
				disableCalls += 1;
				const target = rows.find(r => r.id === id);
				if (!target) return false;
				target.disabledCause = cause;
				return true;
			},
			replaceAuthCredentialsForProvider: () => rows,
			upsertAuthCredentialForProvider: () => rows,
			deleteAuthCredentialsForProvider() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		// Pre-populate the cache with a "last good" report whose inner expiresAt
		// is in the past (so `get()` misses) but the entry is still reachable via
		// `getStale()`. Mirrors what the prior poll would have written.
		const lastGood = makeReport("a@example.com");
		const cacheKey = "usage_cache:report:anthropic:default:oauth|account:account-1|email:a@example.com";
		cache.set(cacheKey, {
			value: JSON.stringify({ value: lastGood, expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.reload();

		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage");

		try {
			const reports = anthropicReports(await storage.fetchUsageReports());

			// No last-good fallback: the row was disabled before lastGood could leak.
			expect(reports).toHaveLength(0);
			// CAS disable was attempted exactly once on the failing row.
			expect(disableCalls).toBe(1);
			expect(rows[0].disabledCause).toContain("invalid_grant");
			// Upstream probe is short-circuited — no point asking the provider
			// with a credential we've just torn down.
			expect(fetchSpy).not.toHaveBeenCalled();
			// Cache entry was neutralized: a future `getStale` lookup (e.g. on
			// re-login under the same account identity) returns null, not the
			// stale report with its already-elapsed `resetsAt`.
			const rawAfter = cache.get(cacheKey);
			expect(rawAfter).toBeDefined();
			const parsedAfter = JSON.parse(rawAfter!.value);
			expect(parsedAfter.value).toBeNull();
			// And a second poll surfaces nothing — the credential is gone from
			// `listAuthCredentials`, so `#collectUsageRequests` doesn't even
			// look it up.
			const secondPoll = anthropicReports(await storage.fetchUsageReports());
			expect(secondPoll).toHaveLength(0);
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("preserves last-good fallback for transient (non-definitive) refresh failures", async () => {
		// Mirror image: a 502 from the token endpoint is transient — we keep the
		// row, fall back to the prior good report, and try again next poll.
		const row = oauthRow(2, "b@example.com");
		(row.credential as { expires: number }).expires = Date.now() - 1000;
		const rows = [row];

		const cache = new Map<string, CacheEntry>();
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(r => !r.disabledCause),
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return true;
			},
			replaceAuthCredentialsForProvider: () => rows,
			upsertAuthCredentialForProvider: () => rows,
			deleteAuthCredentialsForProvider() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const lastGood = makeReport("b@example.com");
		const cacheKey = "usage_cache:report:anthropic:default:oauth|account:account-2|email:b@example.com";
		cache.set(cacheKey, {
			value: JSON.stringify({ value: lastGood, expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("fetch failed: connect ECONNREFUSED 1.2.3.4:443");
			},
		});
		await storage.reload();

		// The provider probe runs with the stale credential and fails — we don't
		// need a real upstream response, just a deterministic null so the lastGood
		// path is the one being tested.
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

		try {
			const reports = anthropicReports(await storage.fetchUsageReports());
			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("b@example.com");
			expect(rows[0].disabledCause).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});
