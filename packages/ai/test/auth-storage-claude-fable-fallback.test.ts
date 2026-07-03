import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, { value: string; expiresAtSec: number }>;
}

function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
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

function baseReport(email: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 10, limit: 100, usedFraction: 0.1, unit: "percent" },
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day" },
				amount: { used: 20, limit: 100, usedFraction: 0.2, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email, accountId: email },
	};
}

function withFable(report: UsageReport, usedFraction: number): UsageReport {
	return {
		...report,
		limits: [
			...report.limits,
			{
				id: "anthropic:7d:fable",
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
				window: { id: "7d", label: "7 Day" },
				amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

function withSharedUsage(report: UsageReport, windowId: "5h" | "7d", usedFraction: number): UsageReport {
	return {
		...report,
		limits: report.limits.map(limit =>
			limit.scope.shared === true && limit.scope.windowId === windowId
				? {
						...limit,
						amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
						status: usedFraction >= 1 ? "exhausted" : "ok",
					}
				: limit,
		),
	};
}

describe("AuthStorage Claude Fable tier fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com"), oauthRow(3, "c@example.com")]);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("does not block OAuth credentials just because the Fable tier is not reported", async () => {
		// All three credentials lack a Fable-specific bucket. Per the user's
		// intent, unknown headroom is not treated as exhausted; the selector
		// still picks the first credential in hashed order and lets the live
		// request decide if the account can serve Fable.
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": baseReport("a@example.com"),
			"oat-2": baseReport("b@example.com"),
			"oat-3": baseReport("c@example.com"),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		// With Fable tier excluded from proactive hard blocks, it should still select the first available key.
		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
	});

	it("uses explicit exhausted Fable tier rows as ranking hints instead of hard blockers", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 1.0),
			"oat-3": withFable(baseReport("c@example.com"), 0.5),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-3");
	});

	it("rotates after a live Fable 429 even when sibling Fable tier rows are exhausted", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withFable(baseReport("a@example.com"), 1.0),
			"oat-2": withFable(baseReport("b@example.com"), 1.0),
			"oat-3": withFable(baseReport("c@example.com"), 1.0),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const firstKey = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(firstKey).toBe("oat-1");

		const result = await storage.markUsageLimitReached("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(result.switched).toBe(true);

		const retryKey = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });
		expect(retryKey).not.toBe(firstKey);
		expect(["oat-2", "oat-3"]).toContain(retryKey as string);
	});

	it("still blocks OAuth credentials with exhausted shared Anthropic limits", async () => {
		const reportsByAccess: Record<string, UsageReport> = {
			"oat-1": withSharedUsage(withFable(baseReport("a@example.com"), 0.1), "7d", 1.0),
			"oat-2": withSharedUsage(withFable(baseReport("b@example.com"), 0.1), "7d", 1.0),
			"oat-3": withFable(baseReport("c@example.com"), 1.0),
		};

		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (!access) return null;
			return reportsByAccess[access] ?? null;
		});

		const key = await storage.getApiKey("anthropic", "session-3", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-3");
	});
});
