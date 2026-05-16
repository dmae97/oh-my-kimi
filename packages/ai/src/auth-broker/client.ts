/**
 * HTTP client for the omp auth-broker server.
 *
 * Used by {@link RemoteAuthCredentialStore} (snapshot pulls) and by
 * `omp auth-broker status` (liveness checks). All endpoints except
 * `/v1/healthz` require a bearer token.
 */
import type { ZodType, infer as zInfer } from "zod/v4";
import type { AuthCredential } from "../auth-storage";
import type {
	CredentialDisableRequest,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	HealthzResponse,
	SnapshotResponse,
	UsageResponse,
} from "./types";
import {
	credentialDisableResponseSchema,
	credentialRefreshResponseSchema,
	credentialUploadResponseSchema,
	healthzResponseSchema,
	snapshotResponseSchema,
	usageResponseSchema,
} from "./wire-schemas";

export interface AuthBrokerClientOptions {
	/** Base URL (e.g. `https://broker.tailnet:8765`). Trailing slashes are trimmed. */
	url: string;
	/** Bearer token used for everything except `healthz`. */
	token: string;
	/** Per-request timeout in milliseconds. Default 10s. */
	timeoutMs?: number;
	/** Retry connection errors this many times. Default 1. */
	maxRetries?: number;
	/** Override fetch (used in tests). Default global `fetch`. */
	fetchImpl?: typeof fetch;
}

export class AuthBrokerError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	constructor(message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
		super(message, { cause: opts.cause });
		this.name = "AuthBrokerError";
		this.status = opts.status;
		this.body = opts.body;
	}
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 1;

export class AuthBrokerClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #fetch: typeof fetch;

	constructor(opts: AuthBrokerClientOptions) {
		this.#baseUrl = opts.url.replace(/\/+$/, "");
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	healthz(): Promise<HealthzResponse> {
		return this.#request("GET", "/v1/healthz", { schema: healthzResponseSchema, auth: false });
	}

	fetchSnapshot(): Promise<SnapshotResponse> {
		// `snapshotResponseSchema` narrows `refresh` to the sentinel literal where
		// the public type uses plain `string`; the wire shape is identical.
		return this.#request("GET", "/v1/snapshot", { schema: snapshotResponseSchema }) as Promise<SnapshotResponse>;
	}

	fetchUsage(): Promise<UsageResponse> {
		// `usageResponseSchema` keeps the report array as `unknown[]` — per-provider
		// usage modules own the inner shape; the broker doesn't re-validate it.
		return this.#request("GET", "/v1/usage", { schema: usageResponseSchema }) as Promise<UsageResponse>;
	}

	async refreshCredential(id: number): Promise<CredentialRefreshResponse> {
		return this.#request("POST", `/v1/credential/${id}/refresh`, {
			schema: credentialRefreshResponseSchema,
		}) as Promise<CredentialRefreshResponse>;
	}

	async disableCredential(id: number, cause: string): Promise<CredentialDisableResponse> {
		const body: CredentialDisableRequest = { cause };
		return this.#request("POST", `/v1/credential/${id}/disable`, {
			body,
			schema: credentialDisableResponseSchema,
		});
	}

	async uploadCredential(provider: string, credential: AuthCredential): Promise<CredentialUploadResponse> {
		const body: CredentialUploadRequest = { provider, credential };
		return this.#request("POST", "/v1/credential", {
			body,
			schema: credentialUploadResponseSchema,
		}) as Promise<CredentialUploadResponse>;
	}

	async #request<TSchema extends ZodType>(
		method: "GET" | "POST",
		path: string,
		opts: { schema: TSchema; auth?: boolean; body?: unknown },
	): Promise<zInfer<TSchema>> {
		const auth = opts.auth ?? true;
		const url = `${this.#baseUrl}${path}`;
		const headers: Record<string, string> = { Accept: "application/json" };
		if (auth) headers.Authorization = `Bearer ${this.#token}`;
		let payload: string | undefined;
		if (opts.body !== undefined) {
			payload = JSON.stringify(opts.body);
			headers["Content-Type"] = "application/json";
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			try {
				const response = await this.#fetch(url, {
					method,
					headers,
					body: payload,
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
				const text = await response.text();
				if (!response.ok) {
					throw new AuthBrokerError(`Auth broker request failed: ${response.status} ${response.statusText}`, {
						status: response.status,
						body: text,
					});
				}
				let raw: unknown;
				try {
					raw = text.length === 0 ? null : JSON.parse(text);
				} catch (parseError) {
					throw new AuthBrokerError("Auth broker returned malformed JSON", {
						status: response.status,
						body: text,
						cause: parseError,
					});
				}
				const validated = opts.schema.safeParse(raw);
				if (!validated.success) {
					throw new AuthBrokerError("Auth broker response failed schema validation", {
						status: response.status,
						body: validated.error.message,
					});
				}
				return validated.data;
			} catch (error) {
				lastError = error;
				if (error instanceof AuthBrokerError && error.status !== undefined) {
					// HTTP errors (4xx/5xx) don't retry — caller knows what to do.
					throw error;
				}
				if (attempt >= this.#maxRetries) break;
			}
		}
		throw new AuthBrokerError(`Auth broker request failed after ${this.#maxRetries + 1} attempt(s)`, {
			cause: lastError,
		});
	}
}
