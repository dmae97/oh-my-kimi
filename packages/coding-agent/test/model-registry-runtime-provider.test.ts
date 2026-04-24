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

		await registry.refreshProvider("anthropic", "offline");
		const anthropicAfterProviderRefresh = registry.getAll().filter(model => model.provider === "anthropic");
		expect(anthropicAfterProviderRefresh.length).toBe(anthropicBefore.length);
		for (const model of anthropicAfterProviderRefresh) {
			expect(model.headers?.[runtimeHeader]).toBe("runtime-header");
		}

		registry.clearSourceRegistrations("ext://runtime");
		const anthropicAfterClear = registry.getAll().filter(model => model.provider === "anthropic");
		for (const model of anthropicAfterClear) {
			expect(model.headers?.[runtimeHeader]).toBeUndefined();
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

	test("runtime model overlays keep provider overrides across refresh cycles", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const runtimeHeader = "X-Runtime-Overlay-Header";
		const overrideBaseUrl = "https://runtime-overridden.example.com/v1";
		const modelId = "runtime-override-survivor";

		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);
		registry.registerProvider(
			"runtime-provider",
			{ baseUrl: overrideBaseUrl, headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);

		const modelAfterOverride = registry.find("runtime-provider", modelId);
		expect(modelAfterOverride).toBeDefined();
		expect(modelAfterOverride?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterOverride?.headers?.[runtimeHeader]).toBe("runtime-header");

		await registry.refresh("offline");
		const modelAfterRefresh = registry.find("runtime-provider", modelId);
		expect(modelAfterRefresh).toBeDefined();
		expect(modelAfterRefresh?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterRefresh?.headers?.[runtimeHeader]).toBe("runtime-header");

		await registry.refreshProvider("runtime-provider", "offline");
		const modelAfterProviderRefresh = registry.find("runtime-provider", modelId);
		expect(modelAfterProviderRefresh).toBeDefined();
		expect(modelAfterProviderRefresh?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterProviderRefresh?.headers?.[runtimeHeader]).toBe("runtime-header");

		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("runtime-provider", modelId)).toBeUndefined();
	});

	test("headers-only runtime override preserves existing baseUrl across refresh", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const modelId = "runtime-headers-only-baseurl-survivor";
		const overrideBaseUrl = "https://runtime-baseurl.example.com/v1";
		const runtimeHeader = "X-Runtime-Headers-Only";

		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);
		registry.registerProvider("runtime-provider", { baseUrl: overrideBaseUrl }, "ext://runtime");
		registry.registerProvider(
			"runtime-provider",
			{ headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);

		const modelAfterHeadersOnly = registry.find("runtime-provider", modelId);
		expect(modelAfterHeadersOnly).toBeDefined();
		expect(modelAfterHeadersOnly?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterHeadersOnly?.headers?.[runtimeHeader]).toBe("runtime-header");

		await registry.refresh("offline");
		const modelAfterRefresh = registry.find("runtime-provider", modelId);
		expect(modelAfterRefresh).toBeDefined();
		expect(modelAfterRefresh?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterRefresh?.headers?.[runtimeHeader]).toBe("runtime-header");

		await registry.refreshProvider("runtime-provider", "offline");
		const modelAfterProviderRefresh = registry.find("runtime-provider", modelId);
		expect(modelAfterProviderRefresh).toBeDefined();
		expect(modelAfterProviderRefresh?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterProviderRefresh?.headers?.[runtimeHeader]).toBe("runtime-header");

		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("runtime-provider", modelId)).toBeUndefined();
	});

	test("runtime headers override modelOverrides headers across refresh cycles", async () => {
		const initialRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		const targetModel = initialRegistry.getAll().find(model => model.provider === "anthropic");
		if (!targetModel) throw new Error("Expected bundled anthropic model");

		const modelId = targetModel.id;
		const sharedHeader = "X-Shared-Provider-Model-Header";
		const configHeaderValue = "config-header";
		const runtimeHeaderValue = "runtime-header";

		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: {
							[modelId]: { headers: { [sharedHeader]: configHeaderValue } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(registry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(configHeaderValue);

		registry.registerProvider(
			"anthropic",
			{ headers: { [sharedHeader]: runtimeHeaderValue } },
			"ext://runtime",
		);
		expect(registry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(runtimeHeaderValue);

		await registry.refresh("offline");
		expect(registry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(runtimeHeaderValue);

		await registry.refreshProvider("anthropic", "offline");
		expect(registry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(runtimeHeaderValue);

		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(configHeaderValue);
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

	test("re-registering a provider replaces overlays and keeps transport overrides stable", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const runtimeHeader = "X-ReRegister-Provider-Header";
		const overrideBaseUrl = "https://runtime-override.example.com/v1";
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
		registry.registerProvider(
			"runtime-provider",
			{ baseUrl: overrideBaseUrl, headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);
		registry.registerProvider("runtime-provider", config2, "ext://runtime");

		expect(registry.find("runtime-provider", "model-v1")).toBeUndefined();
		const modelAfterReplace = registry.find("runtime-provider", "model-v2");
		expect(modelAfterReplace).toBeDefined();
		expect(modelAfterReplace?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterReplace?.headers?.[runtimeHeader]).toBe("runtime-header");

		await registry.refresh("offline");
		const modelAfterRefresh = registry.find("runtime-provider", "model-v2");
		expect(modelAfterRefresh?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterRefresh?.headers?.[runtimeHeader]).toBe("runtime-header");

		await registry.refreshProvider("runtime-provider", "offline");
		const modelAfterProviderRefresh = registry.find("runtime-provider", "model-v2");
		expect(modelAfterProviderRefresh?.baseUrl).toBe(overrideBaseUrl);
		expect(modelAfterProviderRefresh?.headers?.[runtimeHeader]).toBe("runtime-header");
	});

	test("provider source handoff does not retain previous source transport overrides", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const providerName = "shared-runtime-provider";
		const leakedHeader = "X-Old-Source-Header";
		const sourceBBaseUrl = "https://source-b.example.com/v1";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://source-a.example.com/v1",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{ baseUrl: "https://override-a.example.com/v1", headers: { [leakedHeader]: "from-source-a" } },
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{
				baseUrl: sourceBBaseUrl,
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find(providerName, "model-a")).toBeUndefined();
		const modelAfterHandoff = registry.find(providerName, "model-b");
		expect(modelAfterHandoff?.baseUrl).toBe(sourceBBaseUrl);
		expect(modelAfterHandoff?.headers?.[leakedHeader]).toBeUndefined();

		await registry.refresh("offline");
		const modelAfterRefresh = registry.find(providerName, "model-b");
		expect(modelAfterRefresh?.baseUrl).toBe(sourceBBaseUrl);
		expect(modelAfterRefresh?.headers?.[leakedHeader]).toBeUndefined();

		await registry.refreshProvider(providerName, "offline");
		const modelAfterProviderRefresh = registry.find(providerName, "model-b");
		expect(modelAfterProviderRefresh?.baseUrl).toBe(sourceBBaseUrl);
		expect(modelAfterProviderRefresh?.headers?.[leakedHeader]).toBeUndefined();
	});

	test("transport-only source handoff clears previous source headers immediately", async () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const providerName = "anthropic";
		const sourceAHeader = "X-Source-A-Header";
		const sourceBHeader = "X-Source-B-Header";

		registry.registerProvider(
			providerName,
			{ headers: { [sourceAHeader]: "from-source-a" } },
			"ext://a",
		);
		for (const model of registry.getAll().filter(entry => entry.provider === providerName)) {
			expect(model.headers?.[sourceAHeader]).toBe("from-source-a");
		}

		registry.registerProvider(
			providerName,
			{ headers: { [sourceBHeader]: "from-source-b" } },
			"ext://b",
		);
		for (const model of registry.getAll().filter(entry => entry.provider === providerName)) {
			expect(model.headers?.[sourceAHeader]).toBeUndefined();
			expect(model.headers?.[sourceBHeader]).toBe("from-source-b");
		}

		await registry.refresh("offline");
		for (const model of registry.getAll().filter(entry => entry.provider === providerName)) {
			expect(model.headers?.[sourceAHeader]).toBeUndefined();
			expect(model.headers?.[sourceBHeader]).toBe("from-source-b");
		}

		await registry.refreshProvider(providerName, "offline");
		for (const model of registry.getAll().filter(entry => entry.provider === providerName)) {
			expect(model.headers?.[sourceAHeader]).toBeUndefined();
			expect(model.headers?.[sourceBHeader]).toBe("from-source-b");
		}
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
