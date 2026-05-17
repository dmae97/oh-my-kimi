/**
 * Wire types shared between the auth-broker server and clients.
 *
 * The broker holds OAuth refresh tokens and exposes a redacted snapshot;
 * clients use `access` tokens directly and call back to the broker when a
 * credential expires or a 401 surfaces on a supposedly-fresh credential.
 */

import type { AuthCredential, AuthCredentialSnapshot, AuthCredentialSnapshotEntry } from "../auth-storage";
import type { UsageReport } from "../usage";

/** GET /v1/healthz response body. */
export interface HealthzResponse {
	ok: boolean;
	version?: string;
}

export interface RefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepInMs: number;
}

export type SnapshotEntry = AuthCredentialSnapshotEntry & {
	rotatesInMs: number | null;
};

/** GET /v1/snapshot response body. */
export interface SnapshotResponse extends Omit<AuthCredentialSnapshot, "credentials"> {
	serverNowMs: number;
	refresher: RefresherSchedule;
	credentials: SnapshotEntry[];
}

/** GET /v1/usage response body — matches the local `AuthStorage.fetchUsageReports` shape. */
export interface UsageResponse {
	generatedAt: number;
	reports: UsageReport[];
}

/** POST /v1/credential/:id/refresh response body. */
export interface CredentialRefreshResponse {
	entry: AuthCredentialSnapshotEntry;
}

/** POST /v1/credential/:id/disable request body. */
export interface CredentialDisableRequest {
	cause: string;
}

/** POST /v1/credential/:id/disable response body. */
export interface CredentialDisableResponse {
	ok: boolean;
}

/**
 * POST /v1/credential request body. The OAuth `refresh` must be the *real*
 * refresh token (not the sentinel) — the broker is the canonical writer.
 */
export interface CredentialUploadRequest {
	provider: string;
	credential: AuthCredential;
}

/** POST /v1/credential response body — redacted snapshot of the provider's rows after upsert. */
export interface CredentialUploadResponse {
	entries: AuthCredentialSnapshotEntry[];
}

/**
 * Default bearer-protected route prefix. The broker exposes `/v1/healthz`
 * unauthenticated for liveness probes; everything else requires a bearer.
 */
export const AUTH_BROKER_API_PREFIX = "/v1";

/** Default port when none is configured. Loopback-only, no external exposure. */
export const DEFAULT_AUTH_BROKER_BIND = "127.0.0.1:8765";

/** Default broker→provider refresh skew. Refresh credentials this close to expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

/** Default broker refresh-loop cadence. */
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
