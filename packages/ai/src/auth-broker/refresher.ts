/**
 * Background OAuth refresh loop for the auth-broker server.
 *
 * Iterates active OAuth credentials at `refreshIntervalMs` cadence, refreshing
 * any whose `expires - Date.now() < refreshSkewMs`. Single-flighted per
 * credential id so a long refresh can't be retriggered until it settles.
 *
 * Definitively-failed credentials (invalid_grant / 401 not from network blip)
 * are disabled via {@link AuthStorage.disableCredentialById} so the next
 * snapshot pull surfaces a clean delete on the client.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types";

export interface AuthBrokerRefresherOptions {
	storage: AuthStorage;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Loop cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Override clock (tests). */
	now?: () => number;
}

const INVALID_GRANT_REGEX = /invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i;
const TRANSIENT_REGEX = /timeout|network|fetch failed|ECONNREFUSED/i;
const HTTP_401_403_REGEX = /\b(401|403)\b/;

function isDefinitiveFailure(errorMsg: string): boolean {
	if (INVALID_GRANT_REGEX.test(errorMsg)) return true;
	if (HTTP_401_403_REGEX.test(errorMsg) && !TRANSIENT_REGEX.test(errorMsg)) return true;
	return false;
}

export class AuthBrokerRefresher {
	readonly #storage: AuthStorage;
	readonly #refreshSkewMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	readonly #inFlight: Map<number, Promise<void>> = new Map();
	#timer: NodeJS.Timeout | undefined;
	#running = false;

	constructor(opts: AuthBrokerRefresherOptions) {
		this.#storage = opts.storage;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#now = opts.now ?? Date.now;
	}

	start(): void {
		if (this.#timer !== undefined) return;
		// Refresh sweep is best-effort; kick once immediately so freshly-booted
		// brokers don't hand out near-expired tokens for the first interval.
		void this.tick();
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#refreshIntervalMs);
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	/** Run one sweep. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			await this.#storage.reload();
			const snapshot = this.#storage.exportSnapshot();
			const now = this.#now();
			const deadline = now + this.#refreshSkewMs;
			const targets: number[] = [];
			for (const entry of snapshot.credentials) {
				if (entry.credential.type !== "oauth") continue;
				const expires = entry.credential.expires;
				if (typeof expires !== "number" || !Number.isFinite(expires)) continue;
				if (expires > deadline) continue;
				targets.push(entry.id);
			}
			await Promise.all(targets.map(id => this.#refreshOne(id)));
		} finally {
			this.#running = false;
		}
	}

	#refreshOne(id: number): Promise<void> {
		const existing = this.#inFlight.get(id);
		if (existing) return existing;
		const promise = (async () => {
			try {
				await this.#storage.forceRefreshCredentialById(id);
			} catch (error) {
				const errorMsg = String(error);
				if (isDefinitiveFailure(errorMsg)) {
					logger.warn("auth-broker refresh failed definitively; disabling credential", {
						id,
						error: errorMsg,
					});
					this.#storage.disableCredentialById(id, `auth-broker refresh failed: ${errorMsg}`);
				} else {
					logger.debug("auth-broker refresh failed (transient)", { id, error: errorMsg });
				}
			} finally {
				this.#inFlight.delete(id);
			}
		})();
		this.#inFlight.set(id, promise);
		return promise;
	}
}
