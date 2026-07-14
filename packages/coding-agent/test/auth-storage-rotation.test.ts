import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type UsageProvider, withAuth } from "@oh-my-pi/pi-ai";
import * as oauth from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createApiKeyResolver } from "../src/config/api-key-resolver";

describe("AuthStorage account rotation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let usageExhausted = false;

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

	test("API key resolver re-resolves after a concurrent OAuth refresh makes a 401 bearer stale", async () => {
		const resolvedKeys = ["stale-access", "refreshed-access"];
		const rotationTargets: Array<string | undefined> = [];
		const registry: Parameters<typeof createApiKeyResolver>[0] = {
			async getApiKeyForProvider() {
				return resolvedKeys.shift();
			},
			authStorage: {
				async rotateSessionCredential(_provider, _sessionId, options) {
					rotationTargets.push(options?.apiKey);
					return false;
				},
			},
		};
		const resolver = createApiKeyResolver(registry, "openai-codex", {
			sessionId: "concurrent-oauth-refresh",
		});

		const initial = await resolver({ lastChance: false, error: undefined });
		const refreshed = await resolver({
			lastChance: true,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: initial,
		});

		expect(initial).toBe("stale-access");
		expect(refreshed).toBe("refreshed-access");
		expect(rotationTargets).toEqual(["stale-access"]);
	});

	test("API key resolver stops when a usage-limit rotation has no unblocked sibling", async () => {
		const resolvedKeys = ["quota-blocked-B", "quota-blocked-A"];
		const registry: Parameters<typeof createApiKeyResolver>[0] = {
			async getApiKeyForProvider() {
				return resolvedKeys.shift();
			},
			authStorage: {
				async rotateSessionCredential() {
					return false;
				},
			},
		};
		const attemptedKeys: string[] = [];

		await expect(
			withAuth(createApiKeyResolver(registry, "openai-codex"), async key => {
				attemptedKeys.push(key);
				throw Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again later."), {
					status: 429,
				});
			}),
		).rejects.toThrow("usage limit");

		expect(attemptedKeys).toEqual(["quota-blocked-B"]);
		expect(resolvedKeys).toEqual(["quota-blocked-A"]);
	});

	test("withAuth reaches a fourth healthy Codex OAuth sibling through ModelRegistry", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60_000,
				accountId: "acct-a",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60_000,
				accountId: "acct-b",
			},
			{
				type: "oauth",
				access: "access-c",
				refresh: "refresh-c",
				expires: Date.now() + 60_000,
				accountId: "acct-c",
			},
			{
				type: "oauth",
				access: "access-d",
				refresh: "refresh-d",
				expires: Date.now() + 60_000,
				accountId: "acct-d",
			},
		]);

		const model = getBundledModel("openai-codex", "gpt-5.5");
		if (!model) {
			throw new Error("Expected bundled Codex test model to exist");
		}

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const attemptedKeys: string[] = [];
		const result = await withAuth(modelRegistry.resolver(model, "codex-four-oauth-session"), async key => {
			attemptedKeys.push(key);
			if (key !== "access-d") {
				throw new Error("You have hit your ChatGPT usage limit (pro plan). Try again later.");
			}
			return key;
		});

		expect(result).toBe("access-d");
		expect(attemptedKeys.at(-1)).toBe("access-d");
		expect([...attemptedKeys].sort()).toEqual(["access-a", "access-b", "access-c", "access-d"]);
		expect(new Set(attemptedKeys).size).toBe(4);
	});
});
