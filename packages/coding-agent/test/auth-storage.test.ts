import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "omk-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with $ prefix resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "$TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey with braced env syntax resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_BRACED_API_KEY_12345;
			process.env.TEST_AUTH_BRACED_API_KEY_12345 = "braced-env-api-key-value";
			const bracedKey = "$" + "{TEST_AUTH_BRACED_API_KEY_12345}";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: bracedKey },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("braced-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_BRACED_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_BRACED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey interpolates braced env references inside literals", async () => {
			const originalPartA = process.env.TEST_AUTH_INTERPOLATED_PART_A_12345;
			const originalPartB = process.env.TEST_AUTH_INTERPOLATED_PART_B_12345;
			process.env.TEST_AUTH_INTERPOLATED_PART_A_12345 = "left";
			process.env.TEST_AUTH_INTERPOLATED_PART_B_12345 = "right";
			const interpolatedKey = [
				"$",
				"{TEST_AUTH_INTERPOLATED_PART_A_12345}_$",
				"{TEST_AUTH_INTERPOLATED_PART_B_12345}",
			].join("");

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: interpolatedKey },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("left_right");
			} finally {
				if (originalPartA === undefined) {
					delete process.env.TEST_AUTH_INTERPOLATED_PART_A_12345;
				} else {
					process.env.TEST_AUTH_INTERPOLATED_PART_A_12345 = originalPartA;
				}
				if (originalPartB === undefined) {
					delete process.env.TEST_AUTH_INTERPOLATED_PART_B_12345;
				} else {
					process.env.TEST_AUTH_INTERPOLATED_PART_B_12345 = originalPartB;
				}
			}
		});

		test("apiKey with $$ prefix escapes a leading dollar", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "$$TEST_AUTH_API_KEY_12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("$TEST_AUTH_API_KEY_12345");
		});

		test("apiKey with $! escapes a literal bang and still interpolates later env refs", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "$!literal-$TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("!literal-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("plain API key is used directly even when it matches an env var", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("TEST_AUTH_API_KEY_12345");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("literal public API key is not corrupted by the Windows PUBLIC env var", async () => {
			const originalPublic = process.env.PUBLIC;
			process.env.PUBLIC = "C:\\Users\\Public";

			try {
				writeAuthJson({
					opencode: { type: "api_key", key: "public" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("opencode");

				expect(apiKey).toBe("public");
			} finally {
				if (originalPublic === undefined) {
					delete process.env.PUBLIC;
				} else {
					process.env.PUBLIC = originalPublic;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				// Create multiple AuthStorage instances
				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				// Clear cache and call again
				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: `$${envVarName}` },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("multiple OAuth accounts", () => {
		const callbacks = {
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		};

		test("repeated login appends accounts and persists an explicit selection across instances", async () => {
			const providerId = `test-oauth-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const loginCredentials = [
				{
					refresh: "refresh-a",
					access: "access-a",
					expires: Date.now() + 60_000,
					accountId: "account-a",
					email: "a@example.com",
				},
				{
					refresh: "refresh-b",
					access: "access-b",
					expires: Date.now() + 60_000,
					accountId: "account-b",
					email: "b@example.com",
				},
				{
					refresh: "refresh-a-new",
					access: "access-a-new",
					expires: Date.now() + 60_000,
					accountId: "account-a",
					email: "a@example.com",
				},
			];
			let loginIndex = 0;
			registerOAuthProvider({
				id: providerId,
				name: "Test Multi Account Provider",
				async login() {
					const credentials = loginCredentials[loginIndex++];
					if (!credentials) throw new Error("Unexpected login call");
					return credentials;
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});

			authStorage = AuthStorage.create(authJsonPath);
			const secondInstance = AuthStorage.create(authJsonPath);
			await authStorage.login(providerId, callbacks);
			await secondInstance.login(providerId, callbacks);
			await authStorage.login(providerId, callbacks);

			expect(authStorage.getOAuthAccountCount(providerId)).toBe(2);
			expect(authStorage.listOAuthAccounts(providerId)).toEqual([
				{ index: 0, label: "a@example.com", selected: true },
				{ index: 1, label: "b@example.com", selected: false },
			]);
			expect(await authStorage.getApiKey(providerId)).toBe("access-a-new");
			expect(await authStorage.getApiKey(providerId)).toBe("access-a-new");

			authStorage.selectOAuthAccount(providerId, 1);
			expect(authStorage.getOAuthAccountLabel(providerId)).toBe("b@example.com");
			expect(await authStorage.getApiKey(providerId)).toBe("access-b");
			secondInstance.reload();
			expect(secondInstance.getOAuthAccountLabel(providerId)).toBe("b@example.com");
			expect(await secondInstance.getApiKey(providerId)).toBe("access-b");

			authStorage.logout(providerId);
			secondInstance.reload();
			expect(authStorage.getOAuthAccountCount(providerId)).toBe(0);
			expect(secondInstance.getOAuthAccountCount(providerId)).toBe(0);
		});

		test("uses a provider label resolver for legacy credentials without display metadata", () => {
			const providerId = `test-oauth-label-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Label Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
				getAccountLabel(credentials) {
					return credentials.access === "legacy-access" ? "legacy@example.com" : undefined;
				},
			});
			authStorage = AuthStorage.inMemory({
				[providerId]: {
					type: "oauth",
					refresh: "legacy-refresh",
					access: "legacy-access",
					expires: Date.now() + 60_000,
					accountId: "opaque-oauth-id",
				},
			});

			expect(authStorage.getOAuthAccountLabel(providerId)).toBe("legacy@example.com");
			expect(authStorage.getOAuthAccountLabel(providerId)).not.toContain("opaque-oauth-id");
		});

		test("sanitizes account metadata before rendering labels", () => {
			const providerId = `test-oauth-safe-label-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			authStorage = AuthStorage.inMemory({
				[providerId]: {
					type: "oauth",
					refresh: "safe-refresh",
					access: "safe-access",
					expires: Date.now() + 60_000,
					email: "\u001b[31malice@example.com\n\u202e",
					orgName: "Acme\tCorp\u2066",
				},
			});

			expect(authStorage.getOAuthAccountLabel(providerId)).toBe("alice@example.com (Acme Corp)");
		});

		test("refreshes only the selected account and preserves the other accounts", async () => {
			const providerId = `test-oauth-refresh-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const refreshedAccounts: string[] = [];
			registerOAuthProvider({
				id: providerId,
				name: "Test Multi Account Refresh Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					refreshedAccounts.push(credentials.refresh);
					return {
						refresh: credentials.refresh,
						access: `${credentials.access}-refreshed`,
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});

			const firstAccount = {
				refresh: "refresh-1",
				access: "access-1",
				expires: Date.now() - 1_000,
				email: "first@example.com",
			};
			const secondAccount = {
				refresh: "refresh-2",
				access: "access-2",
				expires: Date.now() + 60_000,
				email: "second@example.com",
			};
			authStorage = AuthStorage.inMemory({
				[providerId]: {
					...firstAccount,
					type: "oauth",
					accounts: [firstAccount, secondAccount],
					activeAccount: 0,
				},
			});

			expect(await authStorage.getApiKey(providerId)).toBe("access-1-refreshed");
			expect(await authStorage.getApiKey(providerId)).toBe("access-1-refreshed");
			authStorage.selectOAuthAccount(providerId, 1);
			expect(await authStorage.getApiKey(providerId)).toBe("access-2");
			expect(refreshedAccounts).toEqual(["refresh-1"]);

			const stored = authStorage.get(providerId);
			expect(stored?.type).toBe("oauth");
			if (stored?.type !== "oauth") throw new Error("Expected OAuth credentials");
			expect(stored.accounts?.[0]).toMatchObject({ access: "access-1-refreshed", email: "first@example.com" });
			expect(stored.accounts?.[1]?.access).toBe("access-2");
			expect(stored.activeAccount).toBe(1);
		});

		test("never falls through to another account when the selected account cannot refresh", async () => {
			const providerId = `test-oauth-refresh-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test Multi Account Fallback Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken() {
					throw new Error("Account refresh rejected");
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});

			const expiredAccount = { refresh: "expired-refresh", access: "expired-access", expires: Date.now() - 1_000 };
			const validAccount = { refresh: "valid-refresh", access: "valid-access", expires: Date.now() + 60_000 };
			authStorage = AuthStorage.inMemory({
				[providerId]: {
					...expiredAccount,
					type: "oauth",
					accounts: [expiredAccount, validAccount],
					activeAccount: 0,
				},
			});

			expect(await authStorage.getApiKey(providerId)).toBeUndefined();
			expect(authStorage.drainErrors()[0]?.message).toContain("Failed to refresh OAuth token");
			authStorage.selectOAuthAccount(providerId, 1);
			expect(await authStorage.getApiKey(providerId)).toBe("valid-access");
			expect(authStorage.getOAuthAccountCount(providerId)).toBe(2);
		});

		test("keeps the legacy single-account storage shape until another account is added", async () => {
			const providerId = `test-oauth-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test Legacy OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});
			const legacyCredential = {
				type: "oauth",
				refresh: "legacy-refresh",
				access: "legacy-access",
				expires: Date.now() + 60_000,
			};
			writeAuthJson({ [providerId]: legacyCredential });
			authStorage = AuthStorage.create(authJsonPath);

			expect(await authStorage.getApiKey(providerId)).toBe("legacy-access");
			expect(JSON.parse(readFileSync(authJsonPath, "utf-8"))[providerId]).toEqual(legacyCredential);
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});

	describe("retired grok-oauth-proxy", () => {
		test("drops grok-oauth-proxy credentials from list and get", () => {
			writeAuthJson({
				xai: {
					type: "oauth",
					access: "xai-access",
					refresh: "xai-refresh",
					expires: Date.now() + 60_000,
				},
				"grok-oauth-proxy": {
					type: "oauth",
					access: "proxy-access",
					refresh: "proxy-refresh",
					expires: Date.now() + 60_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.list()).toEqual(["xai"]);
			expect(authStorage.get("grok-oauth-proxy")).toBeUndefined();
			expect(authStorage.getAuthStatus("grok-oauth-proxy")).toEqual({ configured: false });
		});
	});
});
