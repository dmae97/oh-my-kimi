import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
1: import { type OAuthCredential, type UsageProvider, withAuth } from "@oh-my-pi/pi-ai";
2: import type { OAuthCredentials, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
3: @both
import * as oauth from "@oh-my-pi/pi-ai/oauth";
1: import { type OAuthCredential, type UsageProvider, withAuth } from "@oh-my-pi/pi-ai";
2: import type { OAuthCredentials, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
3: @both
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createApiKeyResolver } from "../src/config/api-key-resolver";

describe("AuthStorage account rotation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let usageExhausted = false;

	const stickyInvalidationSource = "auth-storage-rotation-issue-4982";
	const targetProvider = "issue-4982-target" as OAuthProviderId;
	const unrelatedProvider = "issue-4982-unrelated" as OAuthProviderId;
	let nextLoginCredential: OAuthCredentials | undefined;

	const findSessionWhereFreshSelectionChanges = async (
		provider: string,
		initialCredentials: OAuthCredential[],
		finalCredentials: OAuthCredential[],
	): Promise<{ sessionId: string; stickyKey: string; freshKey: string }> => {
		const control = await AuthStorage.create(path.join(tempDir, `issue-4982-control-${Snowflake.next()}.db`), {
			usageProviderResolver: () => undefined,
		});
		try {
			await control.set(provider, finalCredentials);
			await authStorage.set(provider, initialCredentials);

			for (let attempt = 0; attempt < 128; attempt += 1) {
				const sessionId = `issue-4982-session-${attempt}`;
				const stickyKey = await authStorage.getApiKey(provider, sessionId);
				const freshKey = await control.getApiKey(provider, sessionId);
				if (stickyKey && freshKey && stickyKey !== freshKey) {
					return { sessionId, stickyKey, freshKey };
				}
			}
		} finally {
			control.close();
		}

		throw new Error("expected at least one session whose fresh credential selection changes after login");
	};
	const usageProvider: UsageProvider = {
		id: "openai-codex",
		async fetchUsage(params) {
			const accountId = params.credential.accountId ?? "unknown";
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: `requests-${accountId}`,
						label: "Requests",
						scope: { provider: "openai-codex", accountId },
						amount: { unit: "requests", used: usageExhausted ? 100 : 10, limit: 100 },
						status: usageExhausted ? "exhausted" : "ok",
					},
				],
			};
		},
	};

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-rotation-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		usageExhausted = false;
		nextLoginCredential = undefined;
		for (const provider of [targetProvider, unrelatedProvider]) {
			oauth.registerOAuthProvider({
				id: provider,
				name: provider,
				sourceId: stickyInvalidationSource,
				async login() {
					if (!nextLoginCredential) {
						throw new Error(`missing queued OAuth credential for ${provider}`);
					}
					return nextLoginCredential;
				},
			});
		}

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});

		// Stub the refresh path so AuthStorage doesn't hit a real OAuth endpoint
		// when the credential lands inside the 60s skew. Returning the credential
		// unchanged preserves deterministic access-token routing.
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			return credential;
		});
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential) return null;
			return {
				apiKey: credential.access,
				newCredentials: credential,
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		oauth.unregisterOAuthProviders(stickyInvalidationSource);
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("returns a fallback key when every OAuth account is usage-limited", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "issue-55-session";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(firstKey).toMatch(/^access-/);

		usageExhausted = true;
		const { switched } = await authStorage.markUsageLimitReached("openai-codex", sessionId);
		expect(switched).toBe(true);

		const exhaustedFallbackKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(exhaustedFallbackKey).toMatch(/^access-/);
	});

	test("usage-limit rotation can match the failed bearer when session stickiness is missing", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "missing-sticky-session";
		const result = await authStorage.markUsageLimitReached("openai-codex", sessionId, { apiKey: "access-1" });
		expect(result.switched).toBe(true);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("access-2");
	});

	test("usage-limit rotation trusts the failed bearer over stale session stickiness", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "plus-access",
				refresh: "plus-refresh",
				expires: Date.now() + 60_000,
				accountId: "plus-acct",
			},
			{
				type: "oauth",
				access: "k12-access",
				refresh: "k12-refresh",
				expires: Date.now() + 60_000,
				accountId: "k12-acct",
			},
		]);

		const sessionId = "stale-sticky-session";
		const stickyKey = await authStorage.getApiKey("openai-codex", sessionId);
		const failedKey = stickyKey === "plus-access" ? "k12-access" : "plus-access";
		const result = await authStorage.markUsageLimitReached("openai-codex", sessionId, { apiKey: failedKey });
		expect(result.switched).toBe(true);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe(stickyKey);
	});

1: import { type OAuthCredential, type UsageProvider, withAuth } from "@oh-my-pi/pi-ai";
2: import type { OAuthCredentials, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
3: @both
	});
});
