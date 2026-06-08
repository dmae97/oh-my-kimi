import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { PASTE_CODE_LOGIN_PROVIDERS } from "../src/registry";
import {
	getOAuthProviders,
	refreshOAuthToken,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "../src/registry/oauth";
import * as anthropicOauth from "../src/registry/oauth/anthropic";
import type { OAuthCredentials, OAuthProvider } from "../src/registry/oauth/types";
import { getEnvApiKey } from "../src/stream";

const FIXTURE_SOURCE = "provider-registry-test";
const ENV_KEYS = ["ZENMUX_API_KEY", "EXA_API_KEY"] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	unregisterOAuthProviders(FIXTURE_SOURCE);
	for (const key of ENV_KEYS) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = original;
		}
	}
	vi.restoreAllMocks();
});

describe("provider registry derivation", () => {
	test("descriptors are derived for standard model providers, excluding special-managed ones", () => {
		const zenmux = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "zenmux");
		expect(zenmux).toBeDefined();
		expect(zenmux?.defaultModel).toBe("anthropic/claude-opus-4.6");
		// The derived factory carries the provider identity through.
		expect(zenmux?.createModelManagerOptions({ apiKey: "k" }).providerId).toBe("zenmux");

		// openai-codex is special-managed (bespoke runtime factory) → excluded from descriptors,
		// but still a known model provider with a default.
		expect(PROVIDER_DESCRIPTORS.some(descriptor => descriptor.providerId === "openai-codex")).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER["openai-codex"]).toBe("gpt-5.4");
		// Login-only tools have no default model.
		expect(DEFAULT_MODEL_PER_PROVIDER).not.toHaveProperty("kagi");
	});

	test("env-key map merges registry defs with legacy non-provider keys", () => {
		Bun.env.ZENMUX_API_KEY = "zenmux-env";
		Bun.env.EXA_API_KEY = "exa-env";
		expect(getEnvApiKey("zenmux")).toBe("zenmux-env");
		// Legacy search-tool key preserved (not a registry provider def).
		expect(getEnvApiKey("exa")).toBe("exa-env");
	});

	test("login list contains loginable providers and excludes env-only model providers", () => {
		const ids = getOAuthProviders().map(provider => provider.id);
		expect(ids).toContain("zenmux");
		expect(ids).toContain("kagi");
		// openai has no interactive login flow.
		expect(ids).not.toContain("openai");
	});

	test("paste-code login set is derived from pasteCodeFlow", () => {
		expect([...PASTE_CODE_LOGIN_PROVIDERS].sort()).toEqual(
			["anthropic", "gitlab-duo", "google-antigravity", "google-gemini-cli", "openai-codex"].sort(),
		);
		expect(PASTE_CODE_LOGIN_PROVIDERS.has("zenmux")).toBe(false);
	});

	test("refresh dispatch returns api-key providers unchanged and routes real refreshers", async () => {
		const creds: OAuthCredentials = { refresh: "r", access: "a", expires: Date.now() + 60_000 };
		// zenmux has no refresher → returned as-is.
		expect(await refreshOAuthToken("zenmux", creds)).toBe(creds);

		const refreshed: OAuthCredentials = { refresh: "r2", access: "a2", expires: Date.now() + 120_000 };
		const spy = vi.spyOn(anthropicOauth, "refreshAnthropicToken").mockResolvedValue(refreshed);
		expect(await refreshOAuthToken("anthropic", creds)).toBe(refreshed);
		expect(spy).toHaveBeenCalledWith("r");

		await expect(refreshOAuthToken("nonexistent-provider" as OAuthProvider, creds)).rejects.toThrow(
			"Unknown OAuth provider",
		);
	});

	test("login dispatcher handles runtime-registered extension providers", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: "fixture-x",
			name: "Fixture X",
			sourceId: FIXTURE_SOURCE,
			login: async () => "fixture-key",
		});

		await storage.login("fixture-x", { onAuth: () => {}, onPrompt: async () => "" });

		expect(store.getApiKey("fixture-x")).toBe("fixture-key");
	});
});
