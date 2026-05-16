/**
 * Auth broker HTTP server.
 *
 * Wraps an {@link AuthStorage} (backed by a SQLite store on the broker host)
 * and exposes a minimal REST API for snapshot pulls and explicit refresh /
 * disable operations. Background refresh of expiring credentials lives in
 * {@link AuthBrokerRefresher}.
 *
 * Transport security is delegated to the operator (Tailscale / Wireguard);
 * the server only checks a bearer token against an allow-list per request.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { AuthBrokerRefresher } from "./refresher";
import type {
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadResponse,
	HealthzResponse,
	SnapshotResponse,
} from "./types";
import { DEFAULT_AUTH_BROKER_BIND, DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types";
import { credentialDisableRequestSchema, credentialUploadRequestSchema } from "./wire-schemas";

export interface AuthBrokerServerOptions {
	/** Underlying credential storage (wraps the local SQLite store on the broker). */
	storage: AuthStorage;
	/** Listen address; accepts `host:port` or just `port`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty disables auth (loopback only). */
	bearerTokens: string[];
	/** Broker version string surfaced on `/v1/healthz`. */
	version?: string;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Background refresh cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Disable the background refresher (e.g. for tests). */
	disableRefresher?: boolean;
}

export interface AuthBrokerServerHandle {
	/** Bound URL (`http://host:port`). */
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}

interface ParsedBind {
	hostname: string;
	port: number;
}

function parsePort(raw: string, bind: string): number {
	if (!/^\d+$/.test(raw)) {
		throw new Error(`Invalid bind '${bind}'; port must be an integer.`);
	}
	const port = Number.parseInt(raw, 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid bind '${bind}'; port out of range.`);
	}
	return port;
}

function parseBind(raw: string): ParsedBind {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("Invalid bind; expected 'host:port' or 'port'.");
	}
	if (/^\d+$/.test(trimmed)) {
		return { hostname: "127.0.0.1", port: parsePort(trimmed, raw) };
	}
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon < 0) {
		throw new Error(`Invalid bind '${raw}'; expected 'host:port' or 'port'.`);
	}
	const hostPart = trimmed.slice(0, lastColon);
	const portPart = trimmed.slice(lastColon + 1);
	if (hostPart.length === 0) {
		throw new Error(`Invalid bind '${raw}'; host must not be empty.`);
	}
	return { hostname: hostPart, port: parsePort(portPart, raw) };
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}

/**
 * Parse + validate a JSON request body against a Zod schema. Returns a
 * `Response` (400) on parse/validation failure so handlers can early-return.
 * When `allowEmpty` is set, an empty request body is validated against `{}`.
 */
async function parseBody<T>(
	req: Request,
	schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
	options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid request body: ${String(error)}` }) };
	}
	if (raw.length === 0 && !options.allowEmpty) {
		return { ok: false, response: json(400, { error: "Request body required" }) };
	}
	let parsed: unknown;
	try {
		parsed = raw.length === 0 ? {} : JSON.parse(raw);
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid JSON body: ${String(error)}` }) };
	}
	const result = schema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, response: json(400, { error: result.error.message }) };
	}
	return { ok: true, data: result.data };
}

const REFRESH_ROUTE = /^\/v1\/credential\/(\d+)\/refresh$/;
const DISABLE_ROUTE = /^\/v1\/credential\/(\d+)\/disable$/;

/** Boot the broker. Caller owns lifecycle; `handle.close()` to stop. */
export function startAuthBroker(opts: AuthBrokerServerOptions): AuthBrokerServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_BROKER_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;

	const refresher = opts.disableRefresher
		? undefined
		: new AuthBrokerRefresher({
				storage: opts.storage,
				refreshSkewMs: opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
				refreshIntervalMs: opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
			});
	refresher?.start();

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer =
				req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
			try {
				if (req.method === "GET" && pathname === "/v1/healthz") {
					const body: HealthzResponse = { ok: true, version };
					return json(200, body);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-broker request unauthorized", { method: req.method, path: pathname, peer });
					return json(401, { error: "unauthorized" });
				}
				if (req.method === "GET" && pathname === "/v1/snapshot") {
					await opts.storage.reload();
					const body: SnapshotResponse = opts.storage.exportSnapshot();
					logger.info("auth-broker snapshot served", { peer, credentials: body.credentials.length });
					return json(200, body);
				}
				if (req.method === "GET" && pathname === "/v1/usage") {
					try {
						// AuthStorage caches usage reports internally with a 30s TTL
						// (USAGE_REPORT_TTL_MS) so back-to-back widget polls re-use the
						// last fetch instead of hitting provider endpoints repeatedly.
						const reports = (await opts.storage.fetchUsageReports?.()) ?? [];
						// Drop the `raw` field — it's the provider-specific upstream body,
						// large and unstable. Everything UI-relevant lives in `limits` and
						// `metadata`.
						const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
						logger.info("auth-broker usage served", { peer, reports: trimmed.length });
						return json(200, { generatedAt: Date.now(), reports: trimmed });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker usage fetch failed", { peer, error: message });
						return json(502, { error: message });
					}
				}
				const refreshMatch = req.method === "POST" ? pathname.match(REFRESH_ROUTE) : null;
				if (refreshMatch) {
					const id = Number.parseInt(refreshMatch[1], 10);
					try {
						const entry = await opts.storage.forceRefreshCredentialById(id);
						const body: CredentialRefreshResponse = { entry };
						logger.info("auth-broker credential refreshed", {
							id,
							provider: entry.provider,
							peer,
							expires: entry.credential.type === "oauth" ? entry.credential.expires : undefined,
						});
						return json(200, body);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker refresh failed", { id, peer, error: message });
						const status = message.includes("No credential with id") ? 404 : 500;
						return json(status, { error: message });
					}
				}
				const disableMatch = req.method === "POST" ? pathname.match(DISABLE_ROUTE) : null;
				if (disableMatch) {
					const id = Number.parseInt(disableMatch[1], 10);
					const parsed = await parseBody(req, credentialDisableRequestSchema, { allowEmpty: true });
					if (!parsed.ok) return parsed.response;
					const cause =
						parsed.data.cause && parsed.data.cause.length > 0 ? parsed.data.cause : "disabled via auth-broker";
					const ok = opts.storage.disableCredentialById(id, cause);
					if (!ok) {
						logger.info("auth-broker disable miss", { id, peer, cause });
						return json(404, { error: `No credential with id=${id}` });
					}
					logger.info("auth-broker credential disabled", { id, peer, cause });
					const response: CredentialDisableResponse = { ok: true };
					return json(200, response);
				}
				if (req.method === "POST" && pathname === "/v1/credential") {
					const parsed = await parseBody(req, credentialUploadRequestSchema);
					if (!parsed.ok) return parsed.response;
					const { provider, credential } = parsed.data;
					try {
						const entries = opts.storage.upsertCredential(provider, credential);
						const identity =
							credential.type === "oauth"
								? (credential.email ?? credential.accountId ?? credential.projectId ?? "(no identity)")
								: "(api key)";
						logger.info("auth-broker credential upserted", {
							provider,
							type: credential.type,
							identity,
							peer,
							providerTotal: entries.length,
						});
						const response: CredentialUploadResponse = { entries };
						return json(200, response);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn("auth-broker upload failed", { provider, peer, error: message });
						return json(500, { error: message });
					}
				}
				return json(404, { error: `No route: ${req.method} ${pathname}` });
			} catch (error) {
				logger.error("auth-broker handler crashed", {
					method: req.method,
					path: pathname,
					error: String(error),
				});
				return json(500, { error: "internal error" });
			}
		},
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			refresher?.stop();
			server.stop(true);
		},
	};
}
