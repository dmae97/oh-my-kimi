/**
 * AdaptOrch User API v1 client.
 *
 * This is the hosted path, and it is deliberately separate from
 * `adaptorch-client.ts`: that module wraps the MCP tool surface, which reaches
 * a *local* parent engine, while this one speaks plain HTTPS to the control
 * plane and needs nothing installed beyond an API key.
 *
 * Following the same rule as the MCP wrapper, this package still opens no
 * network I/O of its own. The caller injects `fetch`, so a test never needs a
 * socket and a host application keeps ownership of its HTTP stack.
 */

import type {
	ArtifactListResponse,
	CapabilitySet,
	EvidenceReport,
	ListRunsQuery,
	Principal,
	Run,
	RunListResponse,
	RunSubmission,
} from "./adaptorch-api-types.ts";

export type * from "./adaptorch-api-types.ts";

export interface AdaptOrchRequestInit {
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface AdaptOrchHttpResponse {
	readonly status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

/** Injected HTTP boundary. `globalThis.fetch` satisfies this shape. */
export type AdaptOrchFetch = (url: string, init: AdaptOrchRequestInit) => Promise<AdaptOrchHttpResponse>;

export interface AdaptOrchApiConfig {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly fetch: AdaptOrchFetch;
}

/** A non-2xx response, carrying the server's sanitized code and message. */
export class AdaptOrchApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(status: number, code: string | undefined, message: string) {
		super(message);
		this.name = "AdaptOrchApiError";
		this.status = status;
		this.code = code;
	}
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Choose the credential header.
 *
 * A tenant dashboard key carries the documented `ado_` prefix and must travel
 * only as `X-API-Key`; the contract explicitly forbids also sending it in
 * `Authorization`. Anything else is a non-tenant service credential and uses a
 * bearer token. Sending both would leak a tenant key into a header the control
 * plane does not expect it in.
 */
export function resolveAuthHeaders(apiKey: string): Record<string, string> {
	const key = apiKey.trim();
	if (key === "") throw new Error("AdaptOrch API key is required");
	return key.startsWith("ado_") ? { "X-API-Key": key } : { Authorization: `Bearer ${key}` };
}

/**
 * Reject a base URL that would put a credential on the wire in plaintext.
 * Plain HTTP is allowed only for an exact loopback host, so a lookalike such as
 * `localhost.evil.test` does not slip through a prefix check.
 */
export function assertSafeApiUrl(baseUrl: string): void {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error(`AdaptOrch base URL is not a valid URL: ${baseUrl}`);
	}
	if (url.protocol === "https:") return;
	if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""))) return;
	throw new Error(`AdaptOrch base URL must use https (or http on loopback): ${baseUrl}`);
}

/** Remove a credential from any text that is about to become an error message. */
function redact(text: string, apiKey: string): string {
	const key = apiKey.trim();
	return key === "" ? text : text.split(key).join("[REDACTED]");
}

function readErrorFields(body: unknown): { code?: string; message?: string } {
	if (typeof body !== "object" || body === null) return {};
	const record = body as Record<string, unknown>;
	return {
		...(typeof record.code === "string" ? { code: record.code } : {}),
		...(typeof record.message === "string" ? { message: record.message } : {}),
	};
}

/** Default control-plane origin, overridable with `ADAPTORCH_API_URL`. */
export const ADAPTORCH_DEFAULT_API_URL = "https://api.adaptorch.com";

/**
 * Build a client from the environment: `ADAPTORCH_API_KEY` and an optional
 * `ADAPTORCH_API_URL`. Returns `undefined` when no key is configured, so a
 * caller can treat AdaptOrch as an opt-in the operator enables rather than a
 * dependency that must be present.
 */
export function createAdaptOrchApiClientFromEnv(
	fetchImpl: AdaptOrchFetch,
	env: Readonly<Record<string, string | undefined>> = process.env,
): AdaptOrchApiClient | undefined {
	const apiKey = env.ADAPTORCH_API_KEY?.trim();
	if (!apiKey) return undefined;
	return new AdaptOrchApiClient({
		baseUrl: env.ADAPTORCH_API_URL?.trim() || ADAPTORCH_DEFAULT_API_URL,
		apiKey,
		fetch: fetchImpl,
	});
}

/** Typed client for the AdaptOrch User API v1. */
export class AdaptOrchApiClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly fetch: AdaptOrchFetch;

	constructor(config: AdaptOrchApiConfig) {
		assertSafeApiUrl(config.baseUrl);
		resolveAuthHeaders(config.apiKey);
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.fetch = config.fetch;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const init: AdaptOrchRequestInit = {
			method,
			headers: {
				Accept: "application/json",
				...resolveAuthHeaders(this.apiKey),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		};

		let response: AdaptOrchHttpResponse;
		try {
			response = await this.fetch(`${this.baseUrl}${path}`, init);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`AdaptOrch request failed: ${redact(detail, this.apiKey)}`);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			// A body that is absent or not JSON is not itself a failure: the status
			// still decides, and an error response keeps its generic message.
			payload = undefined;
		}
		if (response.status < 200 || response.status >= 300) {
			const { code, message } = readErrorFields(payload);
			throw new AdaptOrchApiError(
				response.status,
				code,
				redact(message ?? `AdaptOrch request failed with status ${response.status}`, this.apiKey),
			);
		}
		return payload as T;
	}

	/** `GET /v1/capabilities` — API version and enabled features. */
	capabilities(): Promise<CapabilitySet> {
		return this.request<CapabilitySet>("GET", "/v1/capabilities");
	}

	/** `GET /v1/whoami` — the calling principal, for verifying a key works. */
	whoami(): Promise<Principal> {
		return this.request<Principal>("GET", "/v1/whoami");
	}

	/** `POST /v1/runs` — submit work. The contract bounds `subtasks` to 1..50. */
	submitRun(submission: RunSubmission): Promise<Run> {
		return this.request<Run>("POST", "/v1/runs", submission);
	}

	/** `GET /v1/runs` — list runs, filtered by the documented parameters only. */
	listRuns(query: ListRunsQuery = {}): Promise<RunListResponse> {
		const params = new URLSearchParams();
		if (query.status !== undefined) params.set("status", query.status);
		if (query.projectId !== undefined) params.set("project_id", query.projectId);
		if (query.limit !== undefined) params.set("limit", String(query.limit));
		if (query.cursor !== undefined) params.set("cursor", query.cursor);
		const suffix = params.size === 0 ? "" : `?${params.toString()}`;
		return this.request<RunListResponse>("GET", `/v1/runs${suffix}`);
	}

	/** `GET /v1/runs/{run_id}` — one run's current state. */
	getRun(runId: string): Promise<Run> {
		return this.request<Run>("GET", `/v1/runs/${encodeURIComponent(runId)}`);
	}

	/** `PUT /v1/runs/{run_id}/cancel` — request cancellation. */
	cancelRun(runId: string, reason?: string): Promise<Run> {
		return this.request<Run>(
			"PUT",
			`/v1/runs/${encodeURIComponent(runId)}/cancel`,
			reason === undefined ? {} : { reason },
		);
	}

	/** `GET /v1/runs/{run_id}/evidence` — the graded checks for a run. */
	getEvidence(runId: string): Promise<EvidenceReport> {
		return this.request<EvidenceReport>("GET", `/v1/runs/${encodeURIComponent(runId)}/evidence`);
	}

	/** `GET /v1/runs/{run_id}/artifacts` — artifacts a run produced. */
	listArtifacts(runId: string): Promise<ArtifactListResponse> {
		return this.request<ArtifactListResponse>("GET", `/v1/runs/${encodeURIComponent(runId)}/artifacts`);
	}
}
