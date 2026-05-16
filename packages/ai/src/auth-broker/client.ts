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

	healthz(signal?: AbortSignal): Promise<HealthzResponse> {
		return this.#request("GET", "/v1/healthz", { schema: healthzResponseSchema, auth: false, signal });
	}

	fetchSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
		// `snapshotResponseSchema` narrows `refresh` to the sentinel literal where
		// the public type uses plain `string`; the wire shape is identical.
		return this.#request("GET", "/v1/snapshot", {
			schema: snapshotResponseSchema,
			signal,
		}) as Promise<SnapshotResponse>;
	}

	fetchUsage(signal?: AbortSignal): Promise<UsageResponse> {
		// Validates the envelope (`generatedAt`, `reports[].provider`, `limits`,
		// `metadata`) but leaves provider-specific extension fields permissive so
		// the broker can ship new shapes ahead of the client. `raw` is accepted
		// but normally stripped by the broker before send.
		return this.#request("GET", "/v1/usage", { schema: usageResponseSchema, signal }) as Promise<UsageResponse>;
	}

	async refreshCredential(id: number, signal?: AbortSignal): Promise<CredentialRefreshResponse> {
		return this.#request("POST", `/v1/credential/${id}/refresh`, {
			schema: credentialRefreshResponseSchema,
			signal,
		}) as Promise<CredentialRefreshResponse>;
	}

	async disableCredential(id: number, cause: string, signal?: AbortSignal): Promise<CredentialDisableResponse> {
		const body: CredentialDisableRequest = { cause };
		return this.#request("POST", `/v1/credential/${id}/disable`, {
			body,
			schema: credentialDisableResponseSchema,
			signal,
		});
	}

	async uploadCredential(
		provider: string,
		credential: AuthCredential,
		signal?: AbortSignal,
	): Promise<CredentialUploadResponse> {
		const body: CredentialUploadRequest = { provider, credential };
		return this.#request("POST", "/v1/credential", {
			body,
			schema: credentialUploadResponseSchema,
			signal,
		}) as Promise<CredentialUploadResponse>;
	}

	async #request<TSchema extends ZodType>(
		method: "GET" | "POST",
		path: string,
		opts: { schema: TSchema; auth?: boolean; body?: unknown; signal?: AbortSignal },
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

		// Fast-fail when the caller's signal is already aborted — avoids spinning
		// up a fetch + timer that the first `await` would just abort anyway.
		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			// Compose caller's signal with the per-attempt timeout so either
			// source can cancel the in-flight fetch. `AbortSignal.any` is the
			// supported merge primitive in Bun ≥ 1.0 / Node ≥ 20.
			const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
			const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
			try {
				const response = await this.#fetch(url, {
					method,
					headers,
					body: payload,
					signal,
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
				// Caller-driven abort wins over retry — the caller said stop.
				if (opts.signal?.aborted) {
					throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
				}
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
