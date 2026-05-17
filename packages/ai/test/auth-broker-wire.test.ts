import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "../src";
import * as oauthUtils from "../src/utils/oauth";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("auth-broker wire surface", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let token = "";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-wire-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		token = "test-bearer";
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		storage?.close();
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("GET /v1/healthz returns ok without auth", async () => {
		const res = await fetch(`${handle!.url}/v1/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("GET /v1/snapshot requires bearer and redacts refresh tokens", async () => {
		const unauthorized = await fetch(`${handle!.url}/v1/snapshot`);
		expect(unauthorized.status).toBe(401);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const snapshotResult = await client.fetchSnapshot();
		if (snapshotResult.status !== 200) throw new Error("expected snapshot");
		const snapshot = snapshotResult.snapshot;
		expect(snapshot.credentials).toHaveLength(1);
		const entry = snapshot.credentials[0];
		expect(entry.provider).toBe("anthropic");
		expect(entry.credential.type).toBe("oauth");
		if (entry.credential.type === "oauth") {
			expect(entry.credential.access).toBe("access-a");
			// Refresh token is replaced with the wire sentinel — clients never see it.
			expect(entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
	});

	test("GET /v1/snapshot returns generation headers and 304 for unchanged long-poll", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { generation: number; serverNowMs: number; refresher: { enabled: boolean } };
		expect(res.headers.get("etag")).toBe(`"${body.generation}"`);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(body.generation).toBeGreaterThan(0);
		expect(body.serverNowMs).toBeGreaterThan(0);
		expect(body.refresher.enabled).toBe(false);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const unchanged = await client.fetchSnapshot({ ifGenerationGt: body.generation, waitMs: 10 });
		expect(unchanged.status).toBe(304);
		expect(unchanged.generation).toBe(body.generation);
	});

	test("GET /v1/snapshot long-poll wakes when generation changes", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected snapshot");

		const pending = client.fetchSnapshot({ ifGenerationGt: initial.generation, waitMs: 1000 });
		setTimeout(() => {
			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		}, 10);

		const changed = await pending;
		expect(changed.status).toBe(200);
		if (changed.status !== 200) throw new Error("expected changed snapshot");
		expect(changed.generation).toBeGreaterThan(initial.generation);
		expect(
			changed.snapshot.credentials.some(
				entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
			),
		).toBe(true);
	});

	test("POST /v1/credential/:id/refresh forces a refresh and persists the new credential", async () => {
		const refreshed = {
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(refreshed);

		const initialResult = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const id = initialResult.snapshot.credentials[0].id;

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const result = await client.refreshCredential(id);
		expect(result.entry.id).toBe(id);
		if (result.entry.credential.type === "oauth") {
			expect(result.entry.credential.access).toBe("access-rotated");
			expect(result.entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}

		// Underlying SQLite row was updated with the *real* refresh token (no sentinel).
		const persisted = store!.getOAuth("anthropic");
		expect(persisted?.access).toBe("access-rotated");
		expect(persisted?.refresh).toBe("refresh-rotated");
	});

	test("POST /v1/credential/:id/disable soft-deletes the credential and surfaces 404 thereafter", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const id = initialResult.snapshot.credentials[0].id;

		const result = await client.disableCredential(id, "revoked by user");
		expect(result.ok).toBe(true);

		const afterResult = await client.fetchSnapshot();
		if (afterResult.status !== 200) throw new Error("expected snapshot");
		expect(afterResult.snapshot.credentials).toHaveLength(0);

		await expect(client.refreshCredential(id)).rejects.toThrow();
	});

	test("Unknown route returns 404", async () => {
		const res = await fetch(`${handle!.url}/v1/nope`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});
});
