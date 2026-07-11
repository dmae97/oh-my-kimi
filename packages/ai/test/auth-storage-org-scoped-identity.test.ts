/**
 * Anthropic org-scoped credential identity.
 *
 * One Anthropic account email can hold several organizations (a Team seat
 * plus a personal Max plan), each with its own org-scoped token and limit
 * pools. These tests defend the contracts that make that setup storable:
 *
 *   1. Credentials with the same email but different `orgId` coexist as
 *      separate rows; a same-org re-login updates its row in place.
 *   2. A legacy row keyed by bare email is claimed (re-keyed) by the first
 *      org-scoped login with the same email — no duplicate rows.
 *   3. An org-less credential never clobbers org-scoped rows.
 *   4. Usage reports from two orgs on one email do NOT merge into a single
 *      report; org-less reports keep merging by email as before.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { removeWithRetries } from "../../utils/src/temp";

const EMAIL = "shared@example.com";
const TEAM_ORG = "org-team-1111";
const MAX_ORG = "org-max-2222";

function orgCredential(args: { suffix: string; orgId?: string; orgName?: string }): AuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: "account-shared",
		email: EMAIL,
		orgId: args.orgId,
		orgName: args.orgName,
	};
}

function readIdentityRows(dbPath: string): Array<{ identity_key: string | null; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT identity_key, disabled_cause FROM auth_credentials WHERE provider = 'anthropic' ORDER BY id ASC",
			)
			.all() as Array<{ identity_key: string | null; disabled_cause: string | null }>;
	} finally {
		db.close();
	}
}

describe("anthropic org-scoped credential identity", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-org-identity-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("stores two subscriptions of one email side by side and updates same-org logins in place", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "team", orgId: TEAM_ORG }));
		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "max", orgId: MAX_ORG }));

		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${TEAM_ORG}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${MAX_ORG}`, disabled_cause: null },
		]);

		// Same-org re-login: replaces the matching row instead of adding a third.
		const rows = store.upsertAuthCredentialForProvider(
			"anthropic",
			orgCredential({ suffix: "team-renewed", orgId: TEAM_ORG }),
		);
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${TEAM_ORG}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${MAX_ORG}`, disabled_cause: null },
		]);
		const teamRow = rows.find(row => row.credential.type === "oauth" && row.credential.orgId === TEAM_ORG);
		expect(teamRow?.credential.type).toBe("oauth");
		if (teamRow?.credential.type === "oauth") {
			expect(teamRow.credential.access).toBe("access-team-renewed");
		}
	});

	it("upgrades a legacy email-keyed row on the first org-scoped login with the same email", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "legacy" }));
		expect(readIdentityRows(dbPath)).toEqual([{ identity_key: `email:${EMAIL}`, disabled_cause: null }]);

		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "max", orgId: MAX_ORG }));
		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${MAX_ORG}`, disabled_cause: null },
		]);
	});

	it("never clobbers org-scoped rows with an org-less credential", () => {
		if (!store) throw new Error("test setup failed");

		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "team", orgId: TEAM_ORG }));
		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "max", orgId: MAX_ORG }));
		store.upsertAuthCredentialForProvider("anthropic", orgCredential({ suffix: "orgless" }));

		expect(readIdentityRows(dbPath)).toEqual([
			{ identity_key: `email:${EMAIL}|org:${TEAM_ORG}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}|org:${MAX_ORG}`, disabled_cause: null },
			{ identity_key: `email:${EMAIL}`, disabled_cause: null },
		]);
	});
});

// ─── Usage report dedupe partitioning ───────────────────────────────────────

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

function makeStore(
	rows: StoredAuthCredential[],
	onUpdate?: (id: number, credential: AuthCredential) => void,
): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	return {
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential(id, credential) {
			onUpdate?.(id, credential);
		},
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

function oauthRow(
	id: number,
	orgId?: string,
	orgName?: string,
	overrides?: { refresh?: string; expires?: number },
): StoredAuthCredential {
	return {
		id,
		provider: "anthropic",
		credential: {
			type: "oauth",
			access: `oat-${id}`,
			refresh: overrides?.refresh ?? `refresh-${id}`,
			expires: overrides?.expires ?? Date.now() + 3_600_000,
			accountId: "account-shared",
			email: EMAIL,
			orgId,
			orgName,
		},
		disabledCause: null,
	};
}

/** Report carrying ONLY email identity — org attribution must come from the credential. */
function emailOnlyReport(): UsageReport {
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
		metadata: { email: EMAIL, accountId: "account-shared" },
	};
}

describe("anthropic usage report dedupe partitions by org", () => {
	let storage: AuthStorage | null = null;

	afterEach(() => {
		storage?.close();
		storage = null;
		vi.restoreAllMocks();
	});

	it("keeps reports from two orgs on one email separate and attributes each to its org", async () => {
		storage = new AuthStorage(
			makeStore([oauthRow(1, TEAM_ORG, "Team Workspace"), oauthRow(2, MAX_ORG, "Personal Max")]),
			{
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			},
		);
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => emailOnlyReport());

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "anthropic");
		expect(reports).toHaveLength(2);
		const orgIds = reports.map(report => report.metadata?.orgId).sort();
		expect(orgIds).toEqual([MAX_ORG, TEAM_ORG].sort());
		const orgNames = reports.map(report => report.metadata?.orgName).sort();
		expect(orgNames).toEqual(["Personal Max", "Team Workspace"].sort());
	});

	it("attaches the stored org name when the provider response already carries the org id", async () => {
		// Regression: the real Claude usage path stamps orgId from the
		// `anthropic-organization-id` response header, so the orgName fallback
		// must apply independently of the orgId fallback.
		storage = new AuthStorage(makeStore([oauthRow(1, TEAM_ORG, "Team Workspace")]), {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => ({
			...emailOnlyReport(),
			metadata: { email: EMAIL, accountId: "account-shared", orgId: TEAM_ORG },
		}));

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "anthropic");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.metadata?.orgId).toBe(TEAM_ORG);
		expect(reports[0]?.metadata?.orgName).toBe("Team Workspace");
	});

	it("still merges org-less reports with the same email into one row", async () => {
		storage = new AuthStorage(makeStore([oauthRow(1), oauthRow(2)]), {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => emailOnlyReport());

		const reports = ((await storage.fetchUsageReports()) ?? []).filter(r => r.provider === "anthropic");
		expect(reports).toHaveLength(1);
	});
});

describe("broker-backed refresh row addressing", () => {
	let storage: AuthStorage | null = null;

	afterEach(() => {
		storage?.close();
		storage = null;
		vi.restoreAllMocks();
	});

	it("persists a refresh into the refreshed org's row, not the first sentinel row", async () => {
		// Broker snapshots replace every refresh token with the shared
		// REMOTE_REFRESH_SENTINEL. The sentinel must not act as row identity:
		// with two same-email orgs, refreshing the expired Max row previously
		// matched the Team row first and persisted the new token there.
		const teamRow = oauthRow(1, TEAM_ORG, "Team Workspace", { refresh: REMOTE_REFRESH_SENTINEL });
		const maxRow = oauthRow(2, MAX_ORG, "Personal Max", {
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() - 1_000,
		});
		const updates: number[] = [];
		storage = new AuthStorage(
			makeStore([teamRow, maxRow], id => {
				updates.push(id);
			}),
			{
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
				refreshOAuthCredential: async () => ({
					access: "refreshed-access",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: Date.now() + 3_600_000,
				}),
			},
		);
		await storage.reload();

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => emailOnlyReport());

		await storage.fetchUsageReports();
		// Only the expired Max row (id 2) was rewritten; the Team row was never touched.
		expect(updates).toEqual([2]);
	});
});
