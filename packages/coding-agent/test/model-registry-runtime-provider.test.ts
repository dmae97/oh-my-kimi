import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AssistantMessageEventStream,
	clearCustomApis,
	Effort,
	getCustomApi,
	getOAuthProviders,
	type OAuthCredentials,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry runtime provider registration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	const sourceIds = ["ext://atomic", "ext://runtime", "ext://oauth"];

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		clearCustomApis();
		for (const sourceId of sourceIds) {
			unregisterOAuthProviders(sourceId);
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	test("loads built-in GitLab Duo models and OAuth provider metadata", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("gitlab-duo", "claude-sonnet-4-5-20250929");

		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(getOAuthProviders().some(provider => provider.id === "gitlab-duo")).toBe(true);
	});

	test("validates provider config before mutating custom API state", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const beforeAnthropicCount = registry.getAll().filter(model => model.provider === "anthropic").length;

		const invalidConfig: ProviderConfigInput = {
			api: "custom-atomic-api",
			apiKey: "RUNTIME_KEY",
			streamSimple,
			models: [{ ...baseModel, id: "broken" }],
			// baseUrl intentionally missing to force validation failure
		};

		expect(() => registry.registerProvider("atomic-provider", invalidConfig, "ext://atomic")).toThrow(
			'Provider atomic-provider: "baseUrl" is required when defining custom models.',
		);
		expect(getCustomApi("custom-atomic-api")).toBeUndefined();

		const afterAnthropicCount = registry.getAll().filter(model => model.provider === "anthropic").length;
		expect(afterAnthropicCount).toBe(beforeAnthropicCount);
	});

	test("merges provider/model headers and adds Authorization when authHeader is enabled", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			authHeader: true,
			headers: { "X-Provider": "provider-header" },
			models: [{ ...baseModel, headers: { "X-Model": "model-header" } }],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		const model = registry.find("runtime-provider", "runtime-model");

		expect(model).toBeDefined();
		expect(model?.headers?.Authorization).toBe("Bearer RUNTIME_KEY");
		expect(model?.headers?.["X-Provider"]).toBe("provider-header");
		expect(model?.headers?.["X-Model"]).toBe("model-header");
	});

	test("registerProvider applies headers-only overrides to existing provider models across refresh", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const anthropicBefore = registry.getAll().filter(model => model.provider === "anthropic");
		const runtimeHeader = "X-Runtime-Provider-Header";

		expect(anthropicBefore.length).toBeGreaterThan(1);
		registry.registerProvider("anthropic", { headers: { [runtimeHeader]: "runtime-header" } }, "ext://runtime");

		const anthropicAfterRegister = registry.getAll().filter(model => model.provider === "anthropic");
		expect(anthropicAfterRegister.length).toBe(anthropicBefore.length);
		for (const model of anthropicAfterRegister) {
			expect(model.headers?.[runtimeHeader]).toBe("runtime-header");
		}

		await registry.refresh("offline");
		const anthropicAfterRefresh = registry.getAll().filter(model => model.provider === "anthropic");
		expect(anthropicAfterRefresh.length).toBe(anthropicBefore.length);
		for (const model of anthropicAfterRefresh) {
			expect(model.headers?.[runtimeHeader]).toBe("runtime-header");
		}

		registry.clearSourceRegistrations("ext://runtime");
		const anthropicAfterClear = registry.getAll().filter(model => model.provider === "anthropic");
		for (const model of anthropicAfterClear) {
			expect(model.headers?.[runtimeHeader]).toBeUndefined();
		}
	});

	test("registerProvider applies baseUrl-only overrides to existing provider models across refresh", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const proxyBaseUrl = "https://runtime-proxy.example.com/v1";
		const anthropicBefore = registry.getAll().filter(model => model.provider === "anthropic");

		expect(anthropicBefore.length).toBeGreaterThan(1);
		registry.registerProvider("anthropic", { baseUrl: proxyBaseUrl }, "ext://runtime");

		const anthropicAfterRegister = registry.getAll().filter(model => model.provider === "anthropic");
		for (const model of anthropicAfterRegister) {
			expect(model.baseUrl).toBe(proxyBaseUrl);
		}

		await registry.refresh("offline");
		const anthropicAfterRefresh = registry.getAll().filter(model => model.provider === "anthropic");
		for (const model of anthropicAfterRefresh) {
			expect(model.baseUrl).toBe(proxyBaseUrl);
		}

		registry.clearSourceRegistrations("ext://runtime");
		const anthropicAfterClear = registry.getAll().filter(model => model.provider === "anthropic");
		for (const model of anthropicAfterClear) {
			expect(model.baseUrl).not.toBe(proxyBaseUrl);
		}
	});

	test("registerProvider preserves explicit thinking on runtime models", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "anthropic-messages",
			models: [
				{
					...baseModel,
					id: "runtime-thinking-model",
					reasoning: true,
					thinking: {
						mode: "anthropic-adaptive",
						minLevel: Effort.Minimal,
						maxLevel: Effort.High,
					},
				},
			],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		const model = registry.find("runtime-provider", "runtime-thinking-model");

		expect(model?.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		});
	});

	test("extension-registered models survive refresh('offline') cycle", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.find("runtime-provider", "runtime-model")).toBeDefined();

		await registry.refresh("offline");

		const model = registry.find("runtime-provider", "runtime-model");
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe("https://runtime.example.com/v1");
		expect(model?.api).toBe("openai-completions");
	});

	test("extension-registered models survive refresh('online') cycle", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "online-survivor" }],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.find("runtime-provider", "online-survivor")).toBeDefined();

		await registry.refresh("online");

		const model = registry.find("runtime-provider", "online-survivor");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
	});

	test("extension-registered API keys survive refresh cycle for auth resolution", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		// Set up the env var that the apiKey config references
		process.env.TEST_RUNTIME_KEY = "test-value";

		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "TEST_RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);

		await registry.refresh("offline");

		// The fallback resolver should still find the API key after refresh
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);

		delete process.env.TEST_RUNTIME_KEY;
	});

	test("extension-registered custom API handler survives model refresh", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "custom-runtime-api",
			streamSimple,
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(getCustomApi("custom-runtime-api")).toBeDefined();

		// Custom API registry is separate from model registry — verify it persists
		// Note: refresh clears+re-registers source registrations via sdk.ts,
		// but the custom API registry itself is not cleared by refresh()
		await registry.refresh("offline");

		expect(getCustomApi("custom-runtime-api")).toBeDefined();
	});

	test("re-registering a provider replaces previous runtime overlays", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const config1: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v1", name: "Model V1" }],
		};
		const config2: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v2",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v2", name: "Model V2" }],
		};

		registry.registerProvider("runtime-provider", config1, "ext://runtime");
		expect(registry.find("runtime-provider", "model-v1")).toBeDefined();

		registry.registerProvider("runtime-provider", config2, "ext://runtime");
		expect(registry.find("runtime-provider", "model-v2")).toBeDefined();
		expect(registry.find("runtime-provider", "model-v1")).toBeUndefined();

		// After refresh, only v2 should exist
		await registry.refresh("offline");
		expect(registry.find("runtime-provider", "model-v2")).toBeDefined();
		expect(registry.find("runtime-provider", "model-v1")).toBeUndefined();
	});

	test("multiple extension providers survive refresh independently", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		registry.registerProvider(
			"provider-a",
			{
				baseUrl: "https://a.example.com",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			"provider-b",
			{
				baseUrl: "https://b.example.com",
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find("provider-a", "model-a")).toBeDefined();
		expect(registry.find("provider-b", "model-b")).toBeDefined();

		await registry.refresh("offline");

		expect(registry.find("provider-a", "model-a")).toBeDefined();
		expect(registry.find("provider-b", "model-b")).toBeDefined();
	});

	test("clearSourceRegistrations and syncExtensionSources remove source-scoped API and OAuth providers", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const oauthCredentials: OAuthCredentials = {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};

		const config: ProviderConfigInput = {
			api: "custom-oauth-api",
			streamSimple,
			oauth: {
				name: "Custom OAuth",
				login: async () => oauthCredentials,
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
			},
		};

		registry.registerProvider("oauth-provider", config, "ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(true);

		registry.clearSourceRegistrations("ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(false);

		registry.registerProvider("oauth-provider", config, "ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(true);

		registry.syncExtensionSources([]);
		expect(getCustomApi("custom-oauth-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(false);
	});
});
