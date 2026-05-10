import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type CredentialDisabledEvent } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";

describe("AuthStorage onCredentialDisabled callback", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-credential-disabled-event-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("fires when an OAuth credential is disabled by a definitive refresh failure", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error(
				'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
			);
		});

		const apiKey = await authStorage.getApiKey("anthropic", "session-disabled-event");

		expect(apiKey).toBeUndefined();
		expect(events).toHaveLength(1);
		expect(events[0]?.provider).toBe("anthropic");
		expect(events[0]?.disabledCause).toContain("invalid_grant");
	});

	test("does not fire for transient (non-definitive) refresh failures", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("fetch failed: ECONNRESET");
		});

		await authStorage.getApiKey("anthropic", "session-transient-failure");

		expect(events).toHaveLength(0);
	});

	test("swallows handler exceptions so disable still completes", async () => {
		if (!authStorage) throw new Error("test setup failed");

		store?.close();
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: () => {
				throw new Error("subscriber exploded");
			},
		});

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		await expect(authStorage.getApiKey("anthropic", "session-handler-throws")).resolves.toBeUndefined();
		expect(authStorage.list()).not.toContain("anthropic");
	});

	test("swallows async handler rejections so the disable path still completes", async () => {
		if (!authStorage) throw new Error("test setup failed");

		store?.close();
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));

		const settled = Promise.withResolvers<void>();
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: async () => {
				// Yield once so the rejection lands on the microtask queue, not synchronously.
				await Promise.resolve();
				settled.resolve();
				throw new Error("async subscriber exploded");
			},
		});

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(authStorage.getApiKey("anthropic", "session-async-handler-throws")).resolves.toBeUndefined();
			// Wait for the handler's microtask + our internal .catch to run.
			await settled.promise;
			await Bun.sleep(0);
			expect(authStorage.list()).not.toContain("anthropic");
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
