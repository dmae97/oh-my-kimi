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
import { AuthCredentialStore } from "../src/auth-storage";
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
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "../src/provider-models/openai-compat";
import { getGitLabDuoModels } from "../src/providers/gitlab-duo";
import { JWT_CLAIM_PATH } from "../src/providers/openai-codex/constants";
import type { Model } from "../src/types";
import { fetchAntigravityDiscoveryModels } from "../src/utils/discovery/antigravity";
import { fetchCodexModels } from "../src/utils/discovery/codex";
import { getOAuthApiKey } from "../src/utils/oauth";
import type { OAuthCredentials, OAuthProvider } from "../src/utils/oauth/types";

const packageRoot = path.join(import.meta.dir, "..");

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const storage = await AuthCredentialStore.open();
		try {
			const storedApiKey = storage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				const storedOAuth = storage.getOAuth(catalog.oauthProvider);
				if (storedOAuth) {
					const result = await getOAuthApiKey(catalog.oauthProvider, { [catalog.oauthProvider]: storedOAuth });
					if (result) {
						storage.saveOAuth(catalog.oauthProvider, result.newCredentials);
						return result.apiKey;
					}
				}
			}
		} finally {
			storage.close();
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
			// contextWindow and maxTokens intentionally NOT overwritten.
			// Limits are provider-specific (e.g. Copilot imposes its own limits
			// that are lower than native provider limits). Cross-provider models.dev
			// references would inflate them.
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
const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

async function getOAuthCredentialsFromStorage(provider: OAuthProvider): Promise<OAuthCredentials | null> {
	try {
		const storage = await AuthCredentialStore.open();
		try {
			const creds = storage.getOAuth(provider);
			if (!creds) {
				return null;
			}
			const result = await getOAuthApiKey(provider, { [provider]: creds });
			if (!result) {
				return null;
			}
			storage.saveOAuth(provider, result.newCredentials);
			return result.newCredentials;
		} finally {
			storage.close();
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
	const credentials = await getOAuthCredentialsFromStorage("google-antigravity");
	if (!credentials) {
		console.log("No Antigravity credentials found, will use previous models");
		return [];
	}
	try {
		console.log("Fetching models from Antigravity API...");
		const discovered = await fetchAntigravityDiscoveryModels({
			token: credentials.access,
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
	const credentials = await getOAuthCredentialsFromStorage("openai-codex");
	if (!credentials) {
		return [];
	}
	try {
		console.log("Fetching models from Codex API...");
		const accessToken = credentials.access;
		const accountId = credentials.accountId ?? extractCodexAccountId(accessToken);
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
			PROVIDER_DESCRIPTORS.filter(isCatalogDescriptor).map(descriptor => fetchProviderModelsFromCatalog(descriptor)),
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

	// Merge previous models.json entries as fallback for any provider/model
	// not fetched dynamically. This replaces all hardcoded fallback lists —
	// static-only providers (vertex, gemini-cli), auth-gated providers when
	// credentials are unavailable, and ad-hoc model additions all persist
	// through the existing models.json seed.
	// Discovery-only providers (local inference servers) — never bundle static models.
	const discoveryOnlyProviders = new Set(["ollama", "vllm"]);
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	for (const models of Object.values(prevModelsJson as Record<string, Record<string, Model>>)) {
		for (const model of Object.values(models)) {
			if (!fetchedKeys.has(`${model.provider}/${model.id}`) && !discoveryOnlyProviders.has(model.provider)) {
				allModels.push(model);
			}
		}
	}

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);

	// Group by provider and sort each provider's models
	const providers: Record<string, Record<string, Model>> = {};
	for (const model of allModels) {
		if (discoveryOnlyProviders.has(model.provider)) continue;
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
