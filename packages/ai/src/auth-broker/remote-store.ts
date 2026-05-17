/**
 * Client-side {@link AuthCredentialStore} that mirrors a remote broker's
 * snapshot. Refresh tokens never leave the broker; mutating methods (`replace*`,
 * `upsert*`, `delete*ForProvider`) throw because login flows are server-side.
 *
 * Cache (`getCache`/`setCache`/`cleanExpiredCache`) is in-memory and ephemeral —
 * usage reports cache TTL is 5 minutes per credential, so durability across
 * runs isn't required.
 */
import { scheduler } from "node:timers/promises";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type AuthCredential,
	type AuthCredentialStore,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
} from "../auth-storage";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import type { OAuthCredentials } from "../utils/oauth/types";
import type { AuthBrokerClient } from "./client";
import type { SnapshotResponse } from "./types";

/**
 * Client-side TTL for the aggregate `/v1/usage` response. Set below the
 * broker server's own 30s usage cache so we typically pick up the broker's
 * cached value instead of re-walking the network — but high enough to absorb
 * the parallel fan-out from `#rankOAuthSelections` into a single round-trip.
 */
const USAGE_CACHE_TTL_MS = 15_000;
const WAIT_THRESHOLD_MS = 1_000;
const MAX_WAIT_MS = 5_000;
const BACKGROUND_WAIT_MS = 30_000;
const BACKGROUND_BACKOFF_INITIAL_MS = 500;
const BACKGROUND_BACKOFF_MAX_MS = 30_000;

function emptySnapshot(): SnapshotResponse {
	return {
		generation: 0,
		generatedAt: 0,
		serverNowMs: 0,
		refresher: {
			enabled: false,
			intervalMs: 0,
			skewMs: 0,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [],
	};
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface UsageCacheEntry {
	reports: UsageReport[];
	fetchedAt: number;
}

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	/**
	 * Initial snapshot. When omitted, callers must call
	 * {@link RemoteAuthCredentialStore.refreshSnapshot} before the first read.
	 */
	initialSnapshot?: SnapshotResponse;
}

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	#snapshot: SnapshotResponse = emptySnapshot();
	#snapshotReceivedAt = Date.now();
	#generation = 0;
	#backgroundAbort = new AbortController();
	#cache: Map<string, CacheEntry> = new Map();
	#usageCache?: UsageCacheEntry;
	#usageInflight?: Promise<UsageReport[] | null>;
	#closed = false;

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		this.#applySnapshot(opts.initialSnapshot ?? emptySnapshot(), opts.initialSnapshot?.generation ?? 0);
		void this.#runBackgroundLongPoll();
	}

	get client(): AuthBrokerClient {
		return this.#client;
	}

	get snapshot(): SnapshotResponse {
		return this.#snapshot;
	}

	#applySnapshot(snapshot: SnapshotResponse, generation: number): void {
		this.#snapshot = snapshot;
		this.#generation = generation;
		this.#snapshotReceivedAt = Date.now();
	}

	async #runBackgroundLongPoll(): Promise<void> {
		let backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
		while (!this.#closed && !this.#backgroundAbort.signal.aborted) {
			try {
				const result = await this.#client.fetchSnapshot({
					ifGenerationGt: this.#generation,
					waitMs: BACKGROUND_WAIT_MS,
					signal: this.#backgroundAbort.signal,
				});
				if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
				backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
			} catch (error) {
				if (this.#closed || this.#backgroundAbort.signal.aborted) break;
				logger.debug("auth-broker background snapshot sync failed", { error: String(error) });
				await scheduler.wait(backoffMs, { signal: this.#backgroundAbort.signal }).catch(() => {});
				backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
			}
		}
	}

	/** Re-hydrate the in-memory snapshot from the broker. */
	async refreshSnapshot(): Promise<SnapshotResponse> {
		const result = await this.#client.fetchSnapshot();
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
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

	async waitForFreshSnapshot(maxWaitMs: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		const result = await this.#client.fetchSnapshot({
			ifGenerationGt: this.#generation,
			waitMs: maxWaitMs,
			signal: opts.signal,
		});
		if (result.status === 200) this.#applySnapshot(result.snapshot, result.generation);
	}

	async prepareForRequest(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry || entry.credential.type !== "oauth" || entry.rotatesInMs === null) return;
		const remainingMs = this.#snapshotReceivedAt + entry.rotatesInMs - Date.now();
		if (remainingMs > WAIT_THRESHOLD_MS) return;
		await this.waitForFreshSnapshot(MAX_WAIT_MS, opts);
	}

	async markCredentialSuspect(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		await this.#client.refreshCredential(credentialId, opts.signal);
		await this.waitForFreshSnapshot(MAX_WAIT_MS, opts);
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
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		const { entry } = await this.#client.refreshCredential(credentialId, signal);
		await this.refreshSnapshot().catch(error => {
			logger.debug("auth-broker snapshot refresh after credential refresh failed", { error: String(error) });
		});
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
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#raceWithSignal(this.#loadUsageReports(), signal);
	}

	/**
	 * Per-credential usage hook consumed by `AuthStorage.#getUsageReport`. Pulls
	 * the aggregate broker `/v1/usage` once and serves all callers from the
	 * same response (coalesced + cached), then matches the credential to a
	 * report by provider + identity (accountId / email / projectId).
	 *
	 * The broker already aggregates with its own 30s TTL on the server side; our
	 * 15s client TTL is below that so we usually re-use the broker's cache too.
	 */
	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		const reports = await this.#raceWithSignal(this.#loadUsageReports(), signal);
		if (!reports) return null;
		return matchUsageReport(reports, provider, credential);
	}

	/**
	 * Reject the awaited promise when the caller's signal aborts, without
	 * affecting the shared upstream fetch. Used to give each caller their
	 * own cancel without one caller's abort cascading into a peer's in-flight
	 * request through the single-flight `#usageInflight`.
	 */
	#raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) return Promise.reject(new Error("auth-broker request aborted"));
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => {
				signal.removeEventListener("abort", onAbort);
				reject(new Error("auth-broker request aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				value => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				err => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	#loadUsageReports(): Promise<UsageReport[] | null> {
		const cached = this.#usageCache;
		if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
			return Promise.resolve(cached.reports);
		}
		if (this.#usageInflight) return this.#usageInflight;
		const inflight = this.#client
			.fetchUsage()
			.then(body => {
				this.#usageCache = { reports: body.reports, fetchedAt: Date.now() };
				return body.reports;
			})
			.catch(error => {
				logger.warn("auth-broker usage fetch failed", { error: String(error) });
				return null;
			})
			.finally(() => {
				this.#usageInflight = undefined;
			});
		this.#usageInflight = inflight;
		return inflight;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#backgroundAbort.abort();
		this.#cache.clear();
	}
}

/**
 * Match a broker-supplied usage report to a specific OAuth credential. The
 * broker returns aggregate reports across all credentials it manages, so we
 * pick the one whose identity (accountId / email / projectId) lines up with
 * the credential the caller is asking about.
 *
 * Falls back to the lone candidate when only one matches the provider; falls
 * through to `null` when nothing matches, which `AuthStorage` treats as "no
 * usage data" (ranking proceeds without a usage signal for this credential).
 */
function matchUsageReport(reports: UsageReport[], provider: Provider, credential: OAuthCredential): UsageReport | null {
	const candidates = reports.filter(report => report.provider === provider);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];
	const accountId = credential.accountId?.trim().toLowerCase();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim().toLowerCase();
	for (const report of candidates) {
		if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
	}
	return null;
}

function reportMatchesIdentity(
	report: UsageReport,
	accountId: string | undefined,
	email: string | undefined,
	projectId: string | undefined,
): boolean {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	if (accountId) {
		const metaAccount = readMetadataString(metadata, "accountId") ?? readMetadataString(metadata, "account_id");
		if (metaAccount && metaAccount.toLowerCase() === accountId) return true;
		for (const limit of report.limits) {
			if (limit.scope.accountId?.toLowerCase() === accountId) return true;
		}
	}
	if (email) {
		const metaEmail = readMetadataString(metadata, "email");
		if (metaEmail && metaEmail.toLowerCase() === email) return true;
	}
	if (projectId) {
		const metaProject = readMetadataString(metadata, "projectId") ?? readMetadataString(metadata, "project_id");
		if (metaProject && metaProject.toLowerCase() === projectId) return true;
		for (const limit of report.limits) {
			if (limit.scope.projectId?.toLowerCase() === projectId) return true;
		}
	}
	return false;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
