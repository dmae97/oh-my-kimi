#!/usr/bin/env bun

// Copilot model premium request multipliers by model identifier.
const COPILOT_PREMIUM_MULTIPLIERS: Record<string, number> = {
	"github-copilot/claude-haiku-4.5": 0.33,
	"github-copilot/claude-opus-4.6": 3,
	"github-copilot/gpt-4o": 0,
	"github-copilot/gpt-5.4-mini": 0.33,
	"github-copilot/grok-code-fast-1": 0.25,
};

import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import { AuthStorage, type OAuthAccess, SqliteAuthCredentialStore } from "../src/auth-storage";
import { createModelManager } from "../src/model-manager";
import {
	applyGeneratedModelPolicies,
	CLOUDFLARE_FALLBACK_MODEL,
	linkOpenAIPromotionTargets,
} from "../src/model-thinking";
import prevModelsJson from "../src/models.json" with { type: "json" };
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
	PROVIDER_DESCRIPTORS,
} from "../src/provider-models/descriptors";
import {
	buildXaiOAuthStaticSeed,
	clampFireworksKimiMaxTokens,
	isFireworksKimiK2ModelId,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
} from "../src/provider-models/openai-compat";
import { getGitLabDuoModels } from "../src/providers/gitlab-duo";
import { JWT_CLAIM_PATH } from "../src/providers/openai-codex/constants";
import type { Model } from "../src/types";
import { fetchAntigravityDiscoveryModels } from "../src/utils/discovery/antigravity";
import { fetchCodexModels } from "../src/utils/discovery/codex";
import type { OAuthProvider } from "../src/utils/oauth/types";

const packageRoot = path.join(import.meta.dir, "..");

/**
 * Local/self-hosted providers (Ollama, vLLM, LM Studio, LiteLLM). Their model
 * catalogs are whatever happens to be running on the machine that invokes the
 * generator — bundling them would leak machine-specific endpoints (e.g.
 * `http://localhost:4000/v1`) into the committed snapshot. They are discovered
 * dynamically at runtime instead, so they are never fetched during generation
 * and never written to models.json.
 */
const DISCOVERY_ONLY_PROVIDERS = new Set(["ollama", "vllm", "lm-studio", "litellm"]);

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const store = await SqliteAuthCredentialStore.open();
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.reload();
			const storedApiKey = await authStorage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				// AuthStorage.getApiKey refreshes through the broker-aware
				// single-flighted machinery, so a build-time invocation no
				// longer silently falls back to bundled models when an
				// expired-but-refreshable OAuth credential is on disk.
				const oauthKey = await authStorage.getApiKey(catalog.oauthProvider);
				if (oauthKey) {
					return oauthKey;
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// Ignore missing/unreadable auth storage.
	}

	return undefined;
}

async function fetchProviderModelsFromCatalog(descriptor: CatalogProviderDescriptor): Promise<Model[]> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return [];
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const manager = createModelManager(descriptor.createModelManagerOptions({ apiKey }));
		const result = await manager.refresh("online");
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models, using fallback models`);
			return [];
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);
		return models;
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return [];
	}
}

async function loadModelsDevData(): Promise<Model[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();
		const models = mapModelsDevToModels(data as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS);
		models.sort((a, b) => a.id.localeCompare(b.id));
		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

function createGlobalModelsDevReferenceMap(modelsDevModels: readonly Model[]): Map<string, Model> {
	const references = new Map<string, Model>();
	for (const model of modelsDevModels) {
		const existing = references.get(model.id);
		if (!existing) {
			references.set(model.id, model);
			continue;
		}
		if (model.contextWindow > existing.contextWindow) {
			references.set(model.id, model);
			continue;
		}
		if (model.contextWindow === existing.contextWindow && model.maxTokens > existing.maxTokens) {
			references.set(model.id, model);
		}
	}
	return references;
}

function inheritModelsDevLimit(value: number, referenceValue: number, unspecifiedValue: number): number {
	return value === unspecifiedValue ? referenceValue : value;
}

function applyGlobalModelsDevFallback(models: readonly Model[], modelsDevModels: readonly Model[]): Model[] {
	const providerScopedKeys = new Set(modelsDevModels.map(model => `${model.provider}/${model.id}`));
	const globalReferences = createGlobalModelsDevReferenceMap(modelsDevModels);
	return models.map(model => {
		if (providerScopedKeys.has(`${model.provider}/${model.id}`)) {
			return model;
		}
		const reference = globalReferences.get(model.id);
		if (!reference) {
			return model;
		}
		return {
			...model,
			name: reference.name,
			reasoning: reference.reasoning,
			input: reference.input,
			// Fill unknown endpoint limits from same-id models.dev references, but keep
			// provider-specific values when discovery returned them explicitly.
			contextWindow: inheritModelsDevLimit(model.contextWindow, reference.contextWindow, UNK_CONTEXT_WINDOW),
			maxTokens: inheritModelsDevLimit(model.maxTokens, reference.maxTokens, UNK_MAX_TOKENS),
		};
	});
}

function applyPremiumMultiplierOverrides(models: readonly Model[]): Model[] {
	return models.map(model => {
		const premiumMultiplier = COPILOT_PREMIUM_MULTIPLIERS[`${model.provider}/${model.id}`];
		if (premiumMultiplier === undefined) {
			return model;
		}
		if (model.premiumMultiplier === premiumMultiplier) {
			return model;
		}
		return {
			...model,
			premiumMultiplier,
		};
	});
}
function hasBillableCost(cost: Model["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function applyCodexPricingFallback(models: readonly Model[]): Model[] {
	const openAIModels = new Map(
		models
			.filter(model => model.provider === "openai" && hasBillableCost(model.cost))
			.map(model => [model.id, model.cost]),
	);

	return models.map(model => {
		if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
			return model;
		}
		if (hasBillableCost(model.cost)) {
			return model;
		}

		const openAICost = openAIModels.get(model.id);
		if (!openAICost) {
			return model;
		}

		return {
			...model,
			cost: { ...openAICost },
		};
	});
}

/**
 * Fireworks-backed Kimi K2.x deployments report `max_completion_tokens: 65536`
 * over `/v1/models`, but Kimi's documented output budget on Fireworks is
 * lower (#1849). Cap them here so the post-processing pass — which also folds
 * in the `prevModelsJson` static fallback used by `firepass` — never lets a
 * stale or inflated upstream value through. The resolver applies the same
 * cap when discovery runs at runtime; this is the bundle-time safety net.
 */
function applyFireworksKimiMaxTokensCap(models: readonly Model[]): Model[] {
	const FIREWORKS_KIMI_PROVIDERS = new Set(["fireworks", "firepass"]);
	return models.map(model => {
		if (!FIREWORKS_KIMI_PROVIDERS.has(model.provider)) return model;
		if (!isFireworksKimiK2ModelId(model.id)) return model;
		const capped = clampFireworksKimiMaxTokens(model.id, model.maxTokens);
		if (capped === model.maxTokens) return model;
		return { ...model, maxTokens: capped };
	});
}

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

async function getOAuthAccessFromStorage(provider: OAuthProvider): Promise<OAuthAccess | null> {
	try {
		const store = await SqliteAuthCredentialStore.open();
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.reload();
			// `getOAuthAccess` runs the full AuthStorage refresh pipeline so an
			// expired-but-refreshable credential gets rotated before discovery,
			// and identity metadata (accountId/projectId/email) flows through
			// for Codex/Antigravity downstream calls.
			return (await authStorage.getOAuthAccess(provider)) ?? null;
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/**
 * Fetch available Antigravity models from the API using the discovery module.
 * Returns empty array if no auth is available (previous models used as fallback).
 */
async function fetchAntigravityModels(): Promise<Model<"google-gemini-cli">[]> {
	const access = await getOAuthAccessFromStorage("google-antigravity");
	if (!access) {
		console.log("No Antigravity credentials found, will use previous models");
		return [];
	}
	try {
		console.log("Fetching models from Antigravity API...");
		const discovered = await fetchAntigravityDiscoveryModels({
			token: access.accessToken,
			endpoint: ANTIGRAVITY_ENDPOINT,
		});
		if (discovered === null) {
			console.warn("Antigravity API fetch failed, will use previous models");
			return [];
		}
		if (discovered.length > 0) {
			console.log(`Fetched ${discovered.length} models from Antigravity API`);
			return discovered;
		}
		console.warn("Antigravity API returned no models, will use previous models");
		return [];
	} catch (error) {
		console.error("Failed to fetch Antigravity models:", error);
		return [];
	}
}

/**
 * Extract accountId from a Codex JWT access token.
 */
function extractCodexAccountId(accessToken: string): string | null {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
		const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
	} catch {
		return null;
	}
}

async function fetchCodexDiscoveryModels(): Promise<Model<"openai-codex-responses">[]> {
	const access = await getOAuthAccessFromStorage("openai-codex");
	if (!access) {
		return [];
	}
	try {
		console.log("Fetching models from Codex API...");
		const accessToken = access.accessToken;
		const accountId = access.accountId ?? extractCodexAccountId(accessToken);
		const codexDiscovery = await fetchCodexModels({
			accessToken,
			accountId: accountId ?? undefined,
		});
		if (codexDiscovery === null) {
			console.warn("Codex API fetch failed");
			return [];
		}
		if (codexDiscovery.models.length > 0) {
			console.log(`Fetched ${codexDiscovery.models.length} models from Codex API`);
			return codexDiscovery.models;
		}
		return [];
	} catch (error) {
		console.error("Failed to fetch Codex models:", error);
		return [];
	}
}

async function generateModels() {
	// Fetch models from dynamic sources
	const modelsDevModels = await loadModelsDevData();
	const catalogProviderModels = (
		await Promise.all(
			PROVIDER_DESCRIPTORS.filter(
				descriptor => isCatalogDescriptor(descriptor) && !DISCOVERY_ONLY_PROVIDERS.has(descriptor.providerId),
			).map(descriptor => fetchProviderModelsFromCatalog(descriptor as CatalogProviderDescriptor)),
		)
	).flat();
	const gitLabDuoModels = getGitLabDuoModels();
	// Combine models (models.dev has priority)
	let allModels = applyGlobalModelsDevFallback(
		[...modelsDevModels, ...catalogProviderModels, ...gitLabDuoModels],
		modelsDevModels,
	);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL);
	}

	// xai-oauth has no upstream catalog source (not in models.dev or
	// MODELS_DEV_PROVIDER_DESCRIPTORS). The curated chat models live in
	// XAI_OAUTH_CURATED_MODELS and reach the runtime via
	// xaiOAuthModelManagerOptions().staticModels. Bundling them here too lets
	// ModelRegistry.#loadModels() pick them up synchronously at boot, so a
	// persisted `modelRoles.default = "xai-oauth/<id>"` is honored before the
	// async refresh fires (interactive boot does not await refresh).
	allModels.push(...buildXaiOAuthStaticSeed());

	const specialDiscoverySources = [
		{ label: "Antigravity", fetch: fetchAntigravityModels },
		{ label: "Codex", fetch: fetchCodexDiscoveryModels },
	] as const;
	const specialDiscoveries = await Promise.all(
		specialDiscoverySources.map(async source => ({
			label: source.label,
			models: await source.fetch(),
		})),
	);
	for (const discovery of specialDiscoveries) {
		if (discovery.models.length > 0) {
			console.log(`Added ${discovery.models.length} models from ${discovery.label} discovery`);
			allModels.push(...discovery.models);
		}
	}

	const modelsDevAuthoritativeProviders = new Set<string>();
	for (const model of modelsDevModels) {
		if (model.provider === "google-vertex") {
			modelsDevAuthoritativeProviders.add(model.provider);
		}
	}
	// Merge previous models.json entries as fallback for provider/model pairs not
	// fetched dynamically. Providers that models.dev covers authoritatively keep
	// the upstream list exactly, so retired entries from the previous snapshot do
	// not reappear during regeneration.
	// Discovery-only providers (local inference servers) — never bundle static models.
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	for (const models of Object.values(prevModelsJson as Record<string, Record<string, Model>>)) {
		for (const model of Object.values(models)) {
			if (
				!fetchedKeys.has(`${model.provider}/${model.id}`) &&
				!DISCOVERY_ONLY_PROVIDERS.has(model.provider) &&
				!modelsDevAuthoritativeProviders.has(model.provider)
			) {
				allModels.push(model);
			}
		}
	}

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyFireworksKimiMaxTokensCap(allModels);
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);

	// Group by provider and sort each provider's models
	const providers: Record<string, Record<string, Model>> = {};
	for (const model of allModels) {
		if (DISCOVERY_ONLY_PROVIDERS.has(model.provider)) continue;
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (models.dev takes priority over endpoint discovery)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Sort providers alphabetically and models within each provider by ID
	const sortObj = <V>(o: Record<string, V>): Record<string, V> => {
		return Object.fromEntries(
			Object.entries(o)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, model]) => [id, model]),
		);
	};

	const MODELS: Record<string, Record<string, Model>> = sortObj(providers);
	for (const key in MODELS) {
		MODELS[key] = sortObj(MODELS[key]);
	}

	// Generate JSON file
	await Bun.write(path.join(packageRoot, "src/models.json"), JSON.stringify(MODELS, null, "	"));
	console.log("Generated src/models.json");

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`
Model Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(MODELS)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// Run the generator
generateModels().catch(console.error);
