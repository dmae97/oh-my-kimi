/**
 * Client-side {@link AuthCredentialStore} that mirrors a remote broker's
 * snapshot. Refresh tokens never leave the broker; mutating methods (`replace*`,
 * `upsert*`, `delete*ForProvider`) throw because login flows are server-side.
 *
 * Cache (`getCache`/`setCache`/`cleanExpiredCache`) is in-memory and ephemeral —
 * usage reports cache TTL is ~30s, so durability across runs isn't required.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	type AuthCredential,
	type AuthCredentialSnapshot,
	type AuthCredentialStore,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
} from "../auth-storage";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import type { OAuthCredentials } from "../utils/oauth/types";
import type { AuthBrokerClient } from "./client";

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	/**
	 * Initial snapshot. When omitted, callers must call
	 * {@link RemoteAuthCredentialStore.refreshSnapshot} before the first read.
	 */
	initialSnapshot?: AuthCredentialSnapshot;
}

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	#snapshot: AuthCredentialSnapshot;
	#cache: Map<string, CacheEntry> = new Map();
	#closed = false;

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		this.#snapshot = opts.initialSnapshot ?? { generatedAt: 0, credentials: [] };
	}

	get client(): AuthBrokerClient {
		return this.#client;
	}

	get snapshot(): AuthCredentialSnapshot {
		return this.#snapshot;
	}

	/** Re-hydrate the in-memory snapshot from the broker. */
	async refreshSnapshot(): Promise<AuthCredentialSnapshot> {
		this.#snapshot = await this.#client.fetchSnapshot();
		return this.#snapshot;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const out: StoredAuthCredential[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (provider !== undefined && entry.provider !== provider) continue;
			out.push({
				id: entry.id,
				provider: entry.provider,
				credential: entry.credential as AuthCredential,
				disabledCause: null,
			});
		}
		return out;
	}

	/**
	 * In-memory update from a successful refresh through the broker. AuthStorage
	 * calls this after `#replaceCredentialAt`; the broker already persisted the
	 * authoritative row, so we just mirror it.
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		for (const entry of this.#snapshot.credentials) {
			if (entry.id !== id) continue;
			entry.credential = credential as typeof entry.credential;
			return;
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		const next = this.#snapshot.credentials.filter(entry => entry.id !== id);
		this.#snapshot = { ...this.#snapshot, credentials: next };
		// Fire-and-forget: tell the broker to persist the disable.
		this.#client.disableCredential(id, disabledCause).catch(error => {
			logger.warn("auth-broker disable propagation failed", { id, error: String(error) });
		});
	}

	tryDisableAuthCredentialIfMatches(id: number, _expectedData: string, disabledCause: string): boolean {
		const found = this.#snapshot.credentials.find(entry => entry.id === id);
		if (!found) return false;
		this.deleteAuthCredential(id, disabledCause);
		return true;
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `omp auth-broker login <provider>` to mutate credentials.",
		);
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `omp auth-broker login <provider>` to mutate credentials.",
		);
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `omp auth-broker logout <provider>` to mutate credentials.",
		);
	}

	getCache(key: string): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (entry.expiresAtSec * 1000 <= Date.now()) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#cache.set(key, { value, expiresAtSec });
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
	}

	/**
	 * Store-level hook consumed by `AuthStorage` — routes refresh through the
	 * broker so the actual refresh token never leaves the broker host. Returns
	 * the broker-redacted credential with {@link REMOTE_REFRESH_SENTINEL} in
	 * the `refresh` slot.
	 */
	async refreshOAuthCredential(
		_provider: Provider,
		credentialId: number,
		_credential: OAuthCredential,
	): Promise<OAuthCredentials> {
		const { entry } = await this.#client.refreshCredential(credentialId);
		if (entry.credential.type !== "oauth") {
			throw new Error(`Broker returned non-OAuth credential for id=${credentialId}`);
		}
		const refreshed = entry.credential;
		return {
			access: refreshed.access,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: refreshed.expires,
			accountId: refreshed.accountId,
			email: refreshed.email,
			projectId: refreshed.projectId,
			enterpriseUrl: refreshed.enterpriseUrl,
		};
	}

	/**
	 * Store-level hook consumed by `AuthStorage.fetchUsageReports()` — proxies
	 * to the broker's `/v1/usage` endpoint. The broker's egress IP isn't
	 * rate-limited by Anthropic's per-IP `/usage` cap the way a heavy
	 * residential laptop is, so all credentials surface every cycle.
	 */
	async fetchUsageReports(): Promise<UsageReport[] | null> {
		const body = await this.#client.fetchUsage();
		return body.reports;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cache.clear();
	}
}
