/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple OMK instances
 * try to refresh tokens simultaneously.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "omk-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "omk-ai/oauth";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

const RETIRED_GROK_OAUTH_PROXY = "grok-oauth-proxy";

function omitRetiredGrokOAuthProxy(data: AuthStorageData): AuthStorageData {
	if (!(RETIRED_GROK_OAUTH_PROXY in data)) return data;
	const { [RETIRED_GROK_OAUTH_PROXY]: _retired, ...kept } = data;
	return kept;
}

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
	/** Complete account list when more than one subscription account is configured. */
	accounts?: OAuthCredentials[];
	/** Index of the account explicitly selected for this provider. */
	activeAccount?: number;
	/** Legacy cursor accepted when migrating older auth.json files. */
	nextAccount?: number;
} & OAuthCredentials;

export interface OAuthAccountSummary {
	index: number;
	label: string;
	selected: boolean;
}

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

const OAUTH_ACCOUNT_ID_FIELDS = ["accountId", "email", "userId", "username"] as const;
const OAUTH_ACCOUNT_LABEL_FIELDS = ["email", "username"] as const;
const OAUTH_ACCOUNT_LABEL_MAX_LENGTH = 96;
const UNSAFE_ACCOUNT_LABEL_PATTERN =
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

function sanitizeOAuthAccountLabel(value: string): string | undefined {
	const sanitized = stripAnsi(value)
		.replace(/[\t\r\n]+/g, " ")
		.replace(UNSAFE_ACCOUNT_LABEL_PATTERN, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, OAUTH_ACCOUNT_LABEL_MAX_LENGTH);
	return sanitized || undefined;
}

function stripOAuthStorageMetadata(credential: OAuthCredential): OAuthCredentials {
	const {
		type: _type,
		accounts: _accounts,
		activeAccount: _activeAccount,
		nextAccount: _nextAccount,
		...credentials
	} = credential;
	return credentials;
}

function getOAuthAccounts(credential: OAuthCredential): OAuthCredentials[] {
	if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
		return credential.accounts;
	}
	return [stripOAuthStorageMetadata(credential)];
}

function normalizeOAuthAccountIndex(index: unknown, accountCount: number): number {
	if (accountCount <= 0 || typeof index !== "number" || !Number.isInteger(index)) {
		return 0;
	}
	return ((index % accountCount) + accountCount) % accountCount;
}

function getSelectedOAuthAccountIndex(credential: OAuthCredential, accountCount: number): number {
	return normalizeOAuthAccountIndex(credential.activeAccount ?? credential.nextAccount, accountCount);
}

function createOAuthCredential(accounts: OAuthCredentials[], activeAccount = 0): OAuthCredential {
	const selectedIndex = normalizeOAuthAccountIndex(activeAccount, accounts.length);
	const selected = accounts[selectedIndex];
	if (!selected) {
		throw new Error("OAuth credential must contain at least one account");
	}
	if (accounts.length === 1) {
		return { ...selected, type: "oauth" };
	}
	return {
		...selected,
		type: "oauth",
		accounts,
		activeAccount: selectedIndex,
	};
}

function getOAuthAccountIdentity(credentials: OAuthCredentials): string | undefined {
	const accountId = credentials.accountId;
	const orgId = credentials.orgId;
	if (typeof accountId === "string" && accountId.trim() && typeof orgId === "string" && orgId.trim()) {
		return `accountId:${accountId.trim().toLowerCase()}:orgId:${orgId.trim().toLowerCase()}`;
	}
	for (const field of OAUTH_ACCOUNT_ID_FIELDS) {
		const value = credentials[field];
		if (typeof value === "string" && value.trim()) {
			return `${field}:${value.trim().toLowerCase()}`;
		}
	}
	return undefined;
}

function getOAuthAccountDisplayLabel(providerId: string, credentials: OAuthCredentials): string | undefined {
	for (const field of OAUTH_ACCOUNT_LABEL_FIELDS) {
		const value = credentials[field];
		if (typeof value === "string" && value.trim()) {
			const label = sanitizeOAuthAccountLabel(value);
			if (!label) continue;
			const orgName =
				typeof credentials.orgName === "string" ? sanitizeOAuthAccountLabel(credentials.orgName) : undefined;
			return sanitizeOAuthAccountLabel(orgName ? `${label} (${orgName})` : label);
		}
	}
	try {
		const label = getOAuthProvider(providerId)?.getAccountLabel?.(credentials);
		return typeof label === "string" ? sanitizeOAuthAccountLabel(label) : undefined;
	} catch {
		return undefined;
	}
}

function findMatchingOAuthAccount(accounts: OAuthCredentials[], credentials: OAuthCredentials): number {
	const identity = getOAuthAccountIdentity(credentials);
	if (identity) {
		const exactMatch = accounts.findIndex((account) => getOAuthAccountIdentity(account) === identity);
		if (exactMatch >= 0) return exactMatch;
	}

	// Let newly enriched credentials update older entries that predate email/org metadata.
	for (const field of OAUTH_ACCOUNT_ID_FIELDS) {
		const value = credentials[field];
		if (typeof value !== "string" || !value.trim()) continue;
		const normalizedValue = value.trim().toLowerCase();
		const orgId = typeof credentials.orgId === "string" ? credentials.orgId.trim().toLowerCase() : "";
		const compatibleMatch = accounts.findIndex((account) => {
			const existingValue = account[field];
			if (typeof existingValue !== "string" || existingValue.trim().toLowerCase() !== normalizedValue) return false;
			const existingOrgId = typeof account.orgId === "string" ? account.orgId.trim().toLowerCase() : "";
			return !orgId || !existingOrgId || orgId === existingOrgId;
		});
		if (compatibleMatch >= 0) return compatibleMatch;
	}

	return accounts.findIndex((account) => account.refresh === credentials.refresh);
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		try {
			return omitRetiredGrokOAuthProxy(JSON.parse(content) as AuthStorageData);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to parse auth storage: ${message}`);
		}
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (provider === RETIRED_GROK_OAUTH_PROXY) {
					delete merged[provider];
				} else if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		if (provider === RETIRED_GROK_OAUTH_PROXY) return undefined;
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		if (provider === RETIRED_GROK_OAUTH_PROXY) {
			delete this.data[provider];
			this.persistProviderChange(provider, undefined);
			return;
		}
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data).filter((provider) => provider !== RETIRED_GROK_OAUTH_PROXY);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		if (provider === RETIRED_GROK_OAUTH_PROXY) return false;
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (provider === RETIRED_GROK_OAUTH_PROXY) return false;
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/** Return the number of stored OAuth accounts for a provider. */
	getOAuthAccountCount(provider: string): number {
		const credential = this.data[provider];
		return credential?.type === "oauth" ? getOAuthAccounts(credential).length : 0;
	}

	/** Return safe, human-readable labels for every stored OAuth account. */
	listOAuthAccounts(provider: string): OAuthAccountSummary[] {
		const credential = this.data[provider];
		if (credential?.type !== "oauth") return [];
		const accounts = getOAuthAccounts(credential);
		const selectedIndex = getSelectedOAuthAccountIndex(credential, accounts.length);
		return accounts.map((account, index) => ({
			index,
			label: getOAuthAccountDisplayLabel(provider, account) ?? `Account ${index + 1}`,
			selected: index === selectedIndex,
		}));
	}

	/** Return the human-readable label of the selected OAuth account. */
	getOAuthAccountLabel(provider: string): string | undefined {
		return this.listOAuthAccounts(provider).find((account) => account.selected)?.label;
	}

	/** Explicitly select and persist the OAuth account used by this provider. */
	selectOAuthAccount(provider: string, accountIndex: number): void {
		this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			const credential = currentData[provider];
			if (credential?.type !== "oauth") {
				throw new Error(`No OAuth accounts configured for ${provider}`);
			}
			const accounts = [...getOAuthAccounts(credential)];
			if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= accounts.length) {
				throw new Error(`Invalid OAuth account index ${accountIndex} for ${provider}`);
			}
			const merged: AuthStorageData = {
				...currentData,
				[provider]: createOAuthCredential(accounts, accountIndex),
			};
			this.data = merged;
			this.loadError = null;
			return { result: undefined, next: JSON.stringify(merged, null, 2) };
		});
	}

	/**
	 * Return the explicitly selected OAuth credentials without refreshing tokens.
	 * Used by provider model customization hooks.
	 */
	getOAuthCredentials(provider: string): OAuthCredentials | undefined {
		const credential = this.data[provider];
		if (credential?.type !== "oauth") {
			return undefined;
		}
		const accounts = getOAuthAccounts(credential);
		return accounts[getSelectedOAuthAccountIndex(credential, accounts.length)];
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (provider === RETIRED_GROK_OAUTH_PROXY) {
			return { configured: false };
		}
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return omitRetiredGrokOAuthProxy({ ...this.data });
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider. Repeated logins append distinct accounts and
	 * update an existing account when the provider exposes a stable identity.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		if (this.loadError) {
			this.data[providerId] = { type: "oauth", ...credentials };
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const existing = currentData[providerId];
				let credential: OAuthCredential;

				if (existing?.type === "oauth") {
					const accounts = [...getOAuthAccounts(existing)];
					const matchingIndex = findMatchingOAuthAccount(accounts, credentials);
					let activeAccount: number;
					if (matchingIndex >= 0) {
						accounts[matchingIndex] = credentials;
						activeAccount = matchingIndex;
					} else {
						accounts.push(credentials);
						activeAccount = accounts.length - 1;
					}
					credential = createOAuthCredential(accounts, activeAccount);
				} else {
					credential = createOAuthCredential([credentials]);
				}

				const merged: AuthStorageData = { ...currentData, [providerId]: credential };
				this.data = merged;
				this.loadError = null;
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/** Resolve the explicitly selected account and refresh it under the storage lock. */
	private async resolveOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		return this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const credential = currentData[providerId];
			if (credential?.type !== "oauth") {
				return { result: null };
			}

			const accounts = [...getOAuthAccounts(credential)];
			const accountIndex = getSelectedOAuthAccountIndex(credential, accounts.length);
			const account = accounts[accountIndex];
			if (!account) return { result: null };

			const resolved =
				Date.now() < account.expires
					? { apiKey: provider.getApiKey(account), newCredentials: account }
					: await getOAuthApiKey(providerId, { [providerId]: account });
			if (!resolved) return { result: null };

			if (resolved.newCredentials === account) {
				return { result: resolved };
			}

			const newCredentials = { ...account, ...resolved.newCredentials };
			accounts[accountIndex] = newCredentials;
			const merged: AuthStorageData = {
				...currentData,
				[providerId]: createOAuthCredential(accounts, accountIndex),
			};
			this.data = merged;
			return {
				result: { ...resolved, newCredentials },
				next: JSON.stringify(merged, null, 2),
			};
		});
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			try {
				const result = await this.resolveOAuthTokenWithLock(providerId);
				if (result) {
					return result.apiKey;
				}
			} catch (error) {
				this.recordError(error);
				// Credentials are preserved so a later request or /login can recover.
				this.reload();
				return undefined;
			}
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
