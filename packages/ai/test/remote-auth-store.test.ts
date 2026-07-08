import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	type CredentialBlockResponse,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { snapshotResponseSchema } from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { type } from "arktype";
import { removeWithRetries } from "../../utils/src/temp";

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("RemoteAuthCredentialStore + AuthStorage integration", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "remote-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		serverStore.saveOAuth("anthropic", {
			access: "server-access-1",
			refresh: "server-refresh-1",
			expires: Date.now() - 60_000, // expired so refresh is forced
			accountId: "account-1",
			email: "a@example.com",
		});
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("client-side AuthStorage refreshes via broker override, never via local OAuth path", async () => {
		// Real refresh executed by the broker server; mock surfaces the rotated tokens.
		const rotated = {
			access: "server-access-rotated",
			refresh: "server-refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialSnapshot = initialResult.snapshot;
		expect(initialSnapshot.credentials).toHaveLength(1);

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
		});

		let overrideCalls = 0;
		const clientStorage = new AuthStorage(remoteStore, {
			refreshOAuthCredential: async (_provider, credentialId, _credential) => {
				overrideCalls += 1;
				const { entry } = await brokerClient.refreshCredential(credentialId);
				if (entry.credential.type !== "oauth") throw new Error("unexpected");
				return {
					access: entry.credential.access,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: entry.credential.expires,
					accountId: entry.credential.accountId,
					email: entry.credential.email,
				};
			},
		});
		await clientStorage.reload();

		const apiKey = await clientStorage.getApiKey("anthropic");
		expect(apiKey).toBe("server-access-rotated");
		expect(overrideCalls).toBe(1);
		// The local oauth refresh helper was used exactly once — by the broker server.
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		clientStorage.close();
	});
	test("suspect credential refresh updates the client snapshot from the broker response", async () => {
		const rotated = {
			access: "server-access-after-401",
			refresh: "server-refresh-after-401",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialEntry = initialResult.snapshot.credentials[0];
		if (!initialEntry) throw new Error("expected credential");

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});

		await remoteStore.markCredentialSuspect(initialEntry.id);
		const rows = remoteStore.listAuthCredentials("anthropic");

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type).toBe("oauth");
		if (rows[0]?.credential.type === "oauth") {
			expect(rows[0].credential.access).toBe("server-access-after-401");
			expect(rows[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		remoteStore.close();
	});

	test("RemoteAuthCredentialStore rejects writes from the client", () => {
		const remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		expect(() => remoteStore.replaceAuthCredentialsForProvider("anthropic", [])).toThrow(/read-only/);
		expect(() => remoteStore.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "x" })).toThrow(
			/read-only/,
		);
		expect(() => remoteStore.deleteAuthCredentialsForProvider("anthropic", "x")).toThrow(/read-only/);
		remoteStore.close();
	});

	test("getUsageReport coalesces parallel callers and matches by identity", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const reportForA = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "a@example.com" },
		};
		const reportForB = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: Date.now(), reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const credB = { ...credA, email: "b@example.com" };

		const [resA, resB] = await Promise.all([
			remoteStore.getUsageReport("anthropic", credA),
			remoteStore.getUsageReport("anthropic", credB),
		]);
		// Parallel callers share a single broker round-trip.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resA?.metadata?.email).toBe("a@example.com");
		expect(resB?.metadata?.email).toBe("b@example.com");

		// Cached on the second call — still one fetch total.
		const cached = await remoteStore.getUsageReport("anthropic", credA);
		expect(cached?.metadata?.email).toBe("a@example.com");
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Unknown provider → null, no extra fetch.
		const miss = await remoteStore.getUsageReport("openai-codex", credA);
		expect(miss).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("broker block snapshots invalidate cached usage before the next fetchUsageReports", async () => {
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const now = Date.now();
		const blockedUntilMs = now + 60_000;
		const credentialEntry = {
			id: 7,
			provider: "anthropic" as const,
			credential: {
				type: "oauth" as const,
				access: "remote-access",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: now + 120_000,
				accountId: "remote-account",
				email: "remote@example.com",
			},
			identityKey: "email:remote@example.com",
			rotatesInMs: null,
		};
		const initialSnapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: now,
			serverNowMs: now,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [credentialEntry],
		};
		const blockedSnapshot: SnapshotResponse = {
			...initialSnapshot,
			generation: 2,
			generatedAt: now + 1,
			serverNowMs: now + 1,
			credentials: [
				{
					...credentialEntry,
					blocks: [{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs }],
				},
			],
		};
		const healthyReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 10, limit: 100, usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "remote-account", email: "remote@example.com", brokerFetch: "before-block" },
		};
		const blockedReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: now + 1,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
			],
			metadata: { accountId: "remote-account", email: "remote@example.com", brokerFetch: "after-block" },
		};
		const fetchUsageSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValueOnce({ generatedAt: now, reports: [healthyReport] })
			.mockResolvedValueOnce({ generatedAt: now + 1, reports: [blockedReport] });
		const backgroundSnapshotFetch = Promise.withResolvers<FetchSnapshotResult>();
		vi.spyOn(brokerClient, "fetchSnapshot")
			.mockReturnValueOnce(backgroundSnapshotFetch.promise)
			.mockResolvedValueOnce({
				status: 200,
				generation: blockedSnapshot.generation,
				snapshot: blockedSnapshot,
			});
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot,
		});
		try {
			const first = await remoteStore.fetchUsageReports();
			expect(fetchUsageSpy).toHaveBeenCalledTimes(1);
			expect(first).not.toBeNull();
			expect(first?.[0]?.metadata?.brokerFetch).toBe("before-block");
			expect(requireLimit(first![0]!, "anthropic:7d:fable").status).toBe("ok");

			await remoteStore.refreshSnapshot();
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(blockedUntilMs);

			const second = await remoteStore.fetchUsageReports();
			expect(fetchUsageSpy).toHaveBeenCalledTimes(2);
			expect(second).not.toBeNull();
			expect(second?.[0]?.metadata?.brokerFetch).toBe("after-block");
			const afterBlockLimit = requireLimit(second![0]!, "anthropic:7d:fable");
			expect(afterBlockLimit.status).toBe("exhausted");
			expect(afterBlockLimit.amount.usedFraction).toBe(1);
		} finally {
			remoteStore.close();
		}
	});

	test("getUsageReport caches broker fetch failure for USAGE_CACHE_TTL_MS", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockRejectedValue(new Error("broker offline"));

		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(1_000_000);

		// First sequential failure caches null.
		const first = await remoteStore.fetchUsageReports();
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Second call within 15s TTL is served from the cached null — no new fetch.
		nowSpy.mockReturnValue(1_000_000 + 14_999);
		const second = await remoteStore.fetchUsageReports();
		expect(second).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// getUsageReport shares the same negative cache.
		const cred = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const perCred = await remoteStore.getUsageReport("anthropic", cred);
		expect(perCred).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// After the documented 15s TTL expires, the client retries once and hits the broker again.
		nowSpy.mockReturnValue(1_000_000 + 15_000 + 1);
		const retried = await remoteStore.fetchUsageReports();
		expect(retried).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		remoteStore.close();
	});

	test("snapshot wire schema accepts entries with and without credential blocks", () => {
		const futureBlock = Date.now() + 60_000;
		const validated = snapshotResponseSchema({
			generation: 1,
			generatedAt: Date.now(),
			serverNowMs: Date.now(),
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [
				{
					id: 1,
					provider: "anthropic",
					credential: {
						type: "oauth",
						access: "access-without-blocks",
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: futureBlock,
						accountId: "account-without-blocks",
						email: "without-blocks@example.com",
					},
					identityKey: "email:without-blocks@example.com",
					rotatesInMs: null,
				},
				{
					id: 2,
					provider: "anthropic",
					credential: {
						type: "oauth",
						access: "access-with-blocks",
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: futureBlock,
						accountId: "account-with-blocks",
						email: "with-blocks@example.com",
					},
					identityKey: "email:with-blocks@example.com",
					rotatesInMs: null,
					blocks: [{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs: futureBlock }],
				},
			],
		});

		expect(validated).not.toBeInstanceOf(type.errors);
		if (validated instanceof type.errors) throw new Error("expected valid snapshot");
		expect(validated.credentials[0]!.blocks).toBeUndefined();
		expect(validated.credentials[1]!.blocks).toEqual([
			{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs: futureBlock },
		]);
	});

	test("RemoteAuthCredentialStore reads snapshot blocks and applies upserts before broker acknowledgement", () => {
		const futureBlock = Date.now() + 60_000;
		const laterBlock = futureBlock + 60_000;
		const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
		const fetchSnapshotPending = Promise.withResolvers<FetchSnapshotResult>();
		vi.spyOn(brokerClient, "fetchSnapshot").mockReturnValue(fetchSnapshotPending.promise);
		const upsertPending = Promise.withResolvers<CredentialBlockResponse>();
		const upsertSpy = vi.spyOn(brokerClient, "upsertCredentialBlock").mockReturnValue(upsertPending.promise);
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			streamSnapshots: false,
			initialSnapshot: {
				generation: 1,
				generatedAt: Date.now(),
				serverNowMs: Date.now(),
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [
					{
						id: 7,
						provider: "anthropic",
						credential: {
							type: "oauth",
							access: "remote-access",
							refresh: REMOTE_REFRESH_SENTINEL,
							expires: futureBlock,
							accountId: "remote-account",
							email: "remote@example.com",
						},
						identityKey: "email:remote@example.com",
						rotatesInMs: null,
						blocks: [{ providerKey: "anthropic:oauth", blockScope: "tier:fable", blockedUntilMs: futureBlock }],
					},
				],
			},
		});
		try {
			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(futureBlock);

			remoteStore.upsertCredentialBlock({
				credentialId: 7,
				providerKey: "anthropic:oauth",
				blockScope: "tier:fable",
				blockedUntilMs: laterBlock,
			});

			expect(remoteStore.getCredentialBlock(7, "anthropic:oauth", "tier:fable")).toBe(laterBlock);
			expect(upsertSpy).toHaveBeenCalledWith(7, {
				providerKey: "anthropic:oauth",
				blockScope: "tier:fable",
				blockedUntilMs: laterBlock,
			});
		} finally {
			remoteStore.close();
		}
	});

	test("ingestUsageReport overlays only the matching Anthropic report and getUsageReport returns the overlaid Fable row", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const now = Date.now();

		const reportForA: UsageReport = {
			provider: "anthropic",
			fetchedAt: now - 20_000,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 11, limit: 100, usedFraction: 0.11, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com" },
		};
		const reportForB: UsageReport = {
			provider: "anthropic",
			fetchedAt: now - 10_000,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 13, limit: 100, usedFraction: 0.13, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-b", email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: now, reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 60_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		const credB = { ...credA, access: "bx", accountId: "account-b", email: "b@example.com" };
		const overlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day", resetsAt: 1_780_617_600_000 },
					amount: {
						used: 61,
						limit: 100,
						usedFraction: 0.61,
						remainingFraction: 0.39,
						unit: "percent",
					},
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com", headersUpdatedAt: 1_780_000_000_000 },
		};

		expect(remoteStore.ingestUsageReport("anthropic", credA, overlay)).toBe(true);

		const reports = await remoteStore.fetchUsageReports();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(reports).not.toBeNull();
		const reportA = reports?.find(report => report.metadata?.accountId === "account-a");
		const reportB = reports?.find(report => report.metadata?.accountId === "account-b");
		if (!reportA || !reportB) throw new Error("expected anthropic reports for both broker accounts");

		expect(reportA.metadata?.email).toBe("a@example.com");
		expect(reportA.metadata?.headersUpdatedAt).toBe(1_780_000_000_000);
		expect(reportA.limits.filter(limit => limit.id === "anthropic:7d:fable")).toHaveLength(1);
		expect(requireLimit(reportA, "anthropic:5h").amount.used).toBe(42);
		expect(requireLimit(reportA, "anthropic:7d").amount.used).toBe(84);
		expect(requireLimit(reportA, "anthropic:7d:opus").amount.used).toBe(12);
		const overlaidFable = requireLimit(reportA, "anthropic:7d:fable");
		expect(overlaidFable.amount.used).toBe(61);
		expect(overlaidFable.amount.usedFraction).toBeCloseTo(0.61);
		expect(overlaidFable.window?.resetsAt).toBe(1_780_617_600_000);

		expect(reportB.metadata?.email).toBe("b@example.com");
		expect(reportB.metadata?.headersUpdatedAt).toBeUndefined();
		expect(requireLimit(reportB, "anthropic:7d:fable").amount.used).toBe(13);

		const perCredA = await remoteStore.getUsageReport("anthropic", credA);
		const perCredB = await remoteStore.getUsageReport("anthropic", credB);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(perCredA).not.toBeNull();
		expect(perCredB).not.toBeNull();
		expect(requireLimit(perCredA!, "anthropic:7d:fable").amount.used).toBe(61);
		expect(requireLimit(perCredB!, "anthropic:7d:fable").amount.used).toBe(13);

		remoteStore.close();
	});

	test("fetchUsageReports keeps a broker failure null even when a client overlay exists", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockRejectedValue(new Error("broker offline"));
		const now = Date.now();
		const cred = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 60_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		const overlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 61, limit: 100, usedFraction: 0.61, remainingFraction: 0.39, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com", headersUpdatedAt: 1_780_000_000_000 },
		};

		expect(remoteStore.ingestUsageReport("anthropic", cred, overlay)).toBe(true);

		const first = await remoteStore.fetchUsageReports();
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const perCred = await remoteStore.getUsageReport("anthropic", cred);
		expect(perCred).not.toBeNull();
		expect(requireLimit(perCred!, "anthropic:7d:fable").amount.used).toBe(61);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const second = await remoteStore.fetchUsageReports();
		expect(second).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("client AuthStorage.set forwards api_key login to the broker (replace semantics)", async () => {
		// Pre-existing api_key for the same provider on the server side — a fresh
		// login should disable it and replace it with the new key.
		serverStore!.saveApiKey("kagi", "old-key");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.set("kagi", { type: "api_key", key: "new-key" });

		// Server is the source of truth — only the new key should be active.
		const activeOnServer = serverStore!.listAuthCredentials("kagi");
		expect(activeOnServer).toHaveLength(1);
		expect(activeOnServer[0].credential).toEqual({ type: "api_key", key: "new-key" });

		// Client reflects the new key through the broker's `POST /v1/credential`
		// response without waiting for the long-poll snapshot tick.
		expect(clientStorage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });
		clientStorage.close();
	});

	test("client AuthStorage.remove disables every broker-side credential for the provider (logout)", async () => {
		serverStore!.saveApiKey("kagi", "k1");
		serverStore!.saveOAuth("kagi", {
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
			accountId: "acct-kagi",
			email: "user@example.com",
		});
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.remove("kagi");

		expect(serverStore!.listAuthCredentials("kagi")).toEqual([]);
		expect(clientStorage.get("kagi")).toBeUndefined();
		clientStorage.close();
	});
});
