/**
 * HTTP client for the omp auth-broker server.
 *
 * Used by {@link RemoteAuthCredentialStore} (snapshot pulls) and by
 * `omp auth-broker status` (liveness checks). All endpoints except
 * `/v1/healthz` require a bearer token.
 */
import { readSseEvents } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { AuthCredential } from "../auth-storage";
import type {
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlocksDeleteResponse,
	CredentialDisableRequest,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	HealthzResponse,
	SnapshotResponse,
	SnapshotStreamEvent,
	UsageResponse,
} from "./types";
import {
	credentialBlockResponseSchema,
	credentialBlocksDeleteResponseSchema,
	credentialDisableResponseSchema,
	credentialRefreshResponseSchema,
	credentialUploadResponseSchema,
	healthzResponseSchema,
	snapshotResponseSchema,
	snapshotStreamEventSchema,
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

/**
 * Thrown when a broker responds 404 to `GET /v1/snapshot/stream` — old
 * brokers that predate the SSE endpoint. Callers (`RemoteAuthCredentialStore`)
 * detect this sentinel to fall back to long-polling permanently.
 */
export class AuthBrokerStreamUnsupportedError extends AuthBrokerError {
	constructor(message = "Auth broker does not support /v1/snapshot/stream") {
		super(message, { status: 404 });
		this.name = "AuthBrokerStreamUnsupportedError";
	}
}

export interface FetchSnapshotOptions {
	ifGenerationGt?: number;
	waitMs?: number;
	signal?: AbortSignal;
}

export type FetchSnapshotResult =
	| { status: 200; snapshot: SnapshotResponse; generation: number }
	| { status: 304; generation: number };

function parseGenerationTag(header: string | null): number | undefined {
	if (!header) return undefined;
	let value = header.trim();
	if (value.startsWith("W/")) value = value.slice(2).trim();
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		value = value.slice(1, -1);
	}
	const generation = Number(value);
	if (!Number.isInteger(generation) || generation < 0) return undefined;
	return generation;
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
		return this.#request<HealthzResponse>("GET", "/v1/healthz", {
			schema: healthzResponseSchema,
			auth: false,
			signal,
		});
	}

	async fetchSnapshot(opts: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> {
		return this.#fetchSnapshotResult(opts);
	}
	async #fetchSnapshotResult(opts: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
		const query = new URLSearchParams();
		if (opts.waitMs !== undefined) query.set("wait", String(opts.waitMs));
		const path = `/v1/snapshot${query.size > 0 ? `?${query.toString()}` : ""}`;
		const headers: Record<string, string> = {};
		if (opts.ifGenerationGt !== undefined) headers["If-None-Match"] = `"${opts.ifGenerationGt}"`;
		const timeoutMs =
			opts.waitMs !== undefined && opts.waitMs > 0 ? Math.max(this.#timeoutMs, opts.waitMs + 1000) : undefined;
		const response = await this.#fetchRaw("GET", path, {
			auth: true,
			headers,
			signal: opts.signal,
			timeoutMs,
		});
		const etagGeneration = parseGenerationTag(response.headers.get("etag"));
		if (response.status === 304) {
			return { status: 304, generation: etagGeneration ?? opts.ifGenerationGt ?? 0 };
		}
		const text = await response.text();
		const raw = this.#parseJson(text, response.status);
		const validated = snapshotResponseSchema(raw);
		if (validated instanceof type.errors) {
			throw new AuthBrokerError("Auth broker response failed schema validation", {
				status: response.status,
				body: validated.summary,
			});
		}
		const snapshot = validated as SnapshotResponse;
		return { status: 200, snapshot, generation: etagGeneration ?? snapshot.generation };
	}

	/**
	 * Subscribe to the broker's SSE snapshot stream. The first frame is always
	 * a full `snapshot`; subsequent frames are `entry` upserts / refreshes or
	 * `removed` deletes. Caller controls lifecycle via `opts.signal`.
	 *
	 * Throws {@link AuthBrokerStreamUnsupportedError} when the broker responds
	 * 404 — older brokers predate this endpoint and the caller should fall back
	 * to long-polling for the remainder of its lifetime.
	 */
	async *openSnapshotStream(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
		const url = `${this.#baseUrl}/v1/snapshot/stream`;
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			Authorization: `Bearer ${this.#token}`,
		};
		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}
		// No timeout: this connection is intentionally long-lived. Caller's signal
		// is the only cancel path.
		const response = await this.#fetch(url, { method: "GET", headers, signal: opts.signal });
		if (response.status === 404) {
			// Drain the body so the socket can be reused; tiny payload.
			await response.text().catch(() => {});
			throw new AuthBrokerStreamUnsupportedError();
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new AuthBrokerError(`Auth broker stream failed: ${response.status} ${response.statusText}`, {
				status: response.status,
				body: text,
			});
		}
		if (!response.body) {
			throw new AuthBrokerError("Auth broker stream response had no body", { status: response.status });
		}
		const contentType = response.headers.get("content-type")?.toLowerCase();
		if (contentType?.split(";", 1)[0].trim() !== "text/event-stream") {
			await response.body.cancel().catch(() => {});
			throw new AuthBrokerError("Auth broker stream returned non-SSE response", {
				status: response.status,
				body: contentType ?? "",
			});
		}

		let sawFirstEvent = false;
		for await (const sse of readSseEvents(response.body, opts.signal)) {
			if (sse.event === null && sse.data === "") continue; // keepalive comment frames
			let parsed: unknown;
			try {
				parsed = JSON.parse(sse.data);
			} catch (err) {
				throw new AuthBrokerError("Auth broker stream returned malformed JSON", {
					body: sse.data,
					cause: err,
				});
			}
			const validated = snapshotStreamEventSchema(parsed);
			if (validated instanceof type.errors) {
				throw new AuthBrokerError("Auth broker stream event failed schema validation", {
					body: validated.summary,
				});
			}
			const event = validated as SnapshotStreamEvent;
			if (!sawFirstEvent) {
				sawFirstEvent = true;
				if (event.kind !== "snapshot") {
					throw new AuthBrokerError("Auth broker stream did not start with snapshot", { body: sse.data });
				}
			}
			yield event;
		}
		if (!opts.signal?.aborted) {
			throw new AuthBrokerError(
				sawFirstEvent
					? "Auth broker stream ended unexpectedly"
					: "Auth broker stream ended before initial snapshot",
				{ status: response.status },
			);
		}
	}

	fetchUsage(signal?: AbortSignal): Promise<UsageResponse> {
		// Validates the envelope (`generatedAt`, `reports[].provider`, `limits`,
		// `metadata`) but leaves provider-specific extension fields permissive so
		// the broker can ship new shapes ahead of the client. `raw` is accepted
		// but normally stripped by the broker before send.
		return this.#request<UsageResponse>("GET", "/v1/usage", { schema: usageResponseSchema, signal });
	}

	async refreshCredential(id: number, signal?: AbortSignal): Promise<CredentialRefreshResponse> {
		return this.#request<CredentialRefreshResponse>("POST", `/v1/credential/${id}/refresh`, {
			schema: credentialRefreshResponseSchema,
			signal,
		});
	}

	async disableCredential(id: number, cause: string, signal?: AbortSignal): Promise<CredentialDisableResponse> {
		const body: CredentialDisableRequest = { cause };
		return this.#request<CredentialDisableResponse>("POST", `/v1/credential/${id}/disable`, {
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
		return this.#request<CredentialUploadResponse>("POST", "/v1/credential", {
			body,
			schema: credentialUploadResponseSchema,
			signal,
		});
	}

	async upsertCredentialBlock(
		id: number,
		block: CredentialBlockRequest,
		signal?: AbortSignal,
	): Promise<CredentialBlockResponse> {
		const body: CredentialBlockRequest = block;
		return this.#request<CredentialBlockResponse>("POST", `/v1/credential/${id}/block`, {
			body,
			schema: credentialBlockResponseSchema,
			signal,
		});
	}

	async deleteCredentialBlocks(id: number, signal?: AbortSignal): Promise<CredentialBlocksDeleteResponse> {
		return this.#request<CredentialBlocksDeleteResponse>("DELETE", `/v1/credential/${id}/blocks`, {
			schema: credentialBlocksDeleteResponseSchema,
			signal,
		});
	}

	async #request<t>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		opts: { schema: (input: unknown) => unknown; auth?: boolean; body?: unknown; signal?: AbortSignal },
	): Promise<t> {
		const response = await this.#fetchRaw(method, path, opts);
		const text = await response.text();
		const raw = this.#parseJson(text, response.status);
		const validated = opts.schema(raw);
		if (validated instanceof type.errors) {
			throw new AuthBrokerError("Auth broker response failed schema validation", {
				status: response.status,
				body: validated.summary,
			});
		}
		return validated as t;
	}

	#parseJson(text: string, status: number): unknown {
		try {
			return text.length === 0 ? null : JSON.parse(text);
		} catch (parseError) {
			throw new AuthBrokerError("Auth broker returned malformed JSON", {
				status,
				body: text,
				cause: parseError,
			});
		}
	}

	async #fetchRaw(
		method: "GET" | "POST" | "DELETE",
		path: string,
		opts: {
			auth?: boolean;
			body?: unknown;
			signal?: AbortSignal;
			headers?: Record<string, string>;
			timeoutMs?: number;
		},
	): Promise<Response> {
		const auth = opts.auth ?? true;
		const url = `${this.#baseUrl}${path}`;
		const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
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
			const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs);
			const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
			try {
				const response = await this.#fetch(url, {
					method,
					headers,
					body: payload,
					signal,
				});
				if (!response.ok && response.status !== 304) {
					const text = await response.text();
					throw new AuthBrokerError(`Auth broker request failed: ${response.status} ${response.statusText}`, {
						status: response.status,
						body: text,
					});
				}
				return response;
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
