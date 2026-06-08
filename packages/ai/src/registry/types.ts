/**
 * Single-source provider model. Every provider — model providers, gateways,
 * search/tool credentials, and login-only flows — is described by one
 * {@link ProviderDefinition}. The legacy scattered structures (the
 * `KnownProvider`/`OAuthProvider` unions, `PROVIDER_DESCRIPTORS`,
 * `serviceProviderMap`, `builtInOAuthProviders`, the refresh/login switches,
 * and the CLI callback maps) are all *derived* from the registry of these
 * definitions. Adding a provider is one new file in `./providers/` plus one
 * line in `./registry.ts`.
 */
import type { ModelManagerOptions } from "../model-manager";
import type { Api } from "../types";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";

/** Config passed to a provider's runtime model-manager factory. */
export type ModelManagerConfig = { apiKey?: string; baseUrl?: string };

/**
 * API-key environment fallback: either a single env var name (e.g.
 * `"OPENAI_API_KEY"`) or a resolver that inspects several env vars / probes
 * the host (Vertex ADC, Bedrock credential chains, …).
 */
export type KeyResolver = string | (() => string | undefined);

/** Catalog discovery configuration for providers that support endpoint-based model listing. */
export interface CatalogDiscoveryConfig {
	/** Human-readable name for log messages. */
	label: string;
	/** Environment variables to check for API keys during catalog generation. */
	envVars: readonly string[];
	/** OAuth provider for credential refresh during catalog generation. */
	oauthProvider?: string;
	/** When true, catalog discovery proceeds even without credentials. */
	allowUnauthenticated?: boolean;
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: string;
	createModelManagerOptions(config: ModelManagerConfig): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/** When true, successful runtime discovery replaces bundled provider models instead of merging fallback-only IDs. */
	dynamicModelsAuthoritative?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
}

/** A provider descriptor that has catalog discovery configured. */
export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

/** Type guard for descriptors with catalog discovery. */
export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery != null;
}

/** Whether catalog discovery may run without provider credentials. */
export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

/**
 * Declarative description of a single provider. All fields are optional except
 * `id`/`name`; presence of a field opts the provider into a derived structure:
 *
 * - `defaultModel` present ⇒ member of `KnownProvider` (a chat-model provider).
 * - `createModelManagerOptions` present (and not `specialModelManager`) ⇒
 *   appears in `PROVIDER_DESCRIPTORS` for runtime model discovery.
 * - `envKeys` present ⇒ env-var fallback in `getEnvApiKey`.
 * - `login` present ⇒ member of `OAuthProvider`, shown in the `/login` list
 *   (unless `showInLoginList === false`) and dispatchable via `AuthStorage.login`.
 * - `callbackPort` present ⇒ entry in the auth-broker `CALLBACK_PORTS` map.
 * - `pasteCodeFlow` ⇒ member of `PASTE_CODE_LOGIN_PROVIDERS`.
 *
 * Heavy OAuth flow modules MUST be reached through dynamic-import thunks in
 * `login`/`refreshToken` so they stay out of the eager startup graph.
 */
export interface ProviderDefinition {
	readonly id: string;
	readonly name: string;
	/** Login-list availability flag. Defaults to true when shown. */
	readonly available?: boolean;
	/** Whether to surface in the interactive login list. Defaults to true when `login` is present. */
	readonly showInLoginList?: boolean;
	// --- model discovery ---
	/** Preferred model ID when no explicit selection is made. Presence ⇒ `KnownProvider` member. */
	readonly defaultModel?: string;
	/** Runtime model-manager factory. Omitted for login-only tools and catalog-only providers. */
	readonly createModelManagerOptions?: (config: ModelManagerConfig) => ModelManagerOptions<Api>;
	/** When true, the runtime creates a model manager even without a valid API key. */
	readonly allowUnauthenticated?: boolean;
	/** When true, successful runtime discovery replaces bundled provider models. */
	readonly dynamicModelsAuthoritative?: boolean;
	/** Catalog discovery configuration for generate-models.ts. */
	readonly catalogDiscovery?: CatalogDiscoveryConfig;
	/**
	 * Providers whose model manager is constructed bespoke in the coding-agent
	 * runtime (`google-antigravity`/`google-gemini-cli`/`openai-codex`). Excluded
	 * from the derived `PROVIDER_DESCRIPTORS`; the registry supplies only their
	 * identity/login/refresh/default-model metadata.
	 */
	readonly specialModelManager?: boolean;
	// --- env-var fallback ---
	readonly envKeys?: KeyResolver;
	// --- interactive login (OAuthProviderInterface-compatible) ---
	readonly login?: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials | string>;
	readonly refreshToken?: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
	readonly getApiKey?: (credentials: OAuthCredentials) => string;
	/** Store OAuth credentials under a different provider id (e.g. `openai-codex-device` ⇒ `openai-codex`). */
	readonly storeCredentialsAs?: string;
	// --- coding-agent login UX ---
	/** Auth-broker local callback-server port. Presence ⇒ entry in `CALLBACK_PORTS`. */
	readonly callbackPort?: number;
	/** OAuth flow needs a pasted code/redirect URL rather than a callback server. */
	readonly pasteCodeFlow?: boolean;
}
