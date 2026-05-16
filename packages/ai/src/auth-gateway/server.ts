/**
 * omp auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → omp Context → pi-ai stream() →
 * omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (30s cache via AuthStorage)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { Effort } from "../model-thinking";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import { streamSimple } from "../stream";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions } from "../types";
import { isAuthorized, json, resolvePeer } from "./http";
import type {
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
}

interface ParsedBind {
	hostname: string;
	port: number;
}

function parseBind(raw: string): ParsedBind {
	const trimmed = raw.trim();
	if (/^\d+$/.test(trimmed)) {
		return { hostname: "127.0.0.1", port: Number.parseInt(trimmed, 10) };
	}
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon < 0) throw new Error(`Invalid bind '${raw}'; expected 'host:port' or 'port'.`);
	const port = Number.parseInt(trimmed.slice(lastColon + 1), 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid bind '${raw}'; port out of range.`);
	}
	return { hostname: trimmed.slice(0, lastColon), port };
}

const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};

/**
 * Wire path on the upstream provider that each inbound format maps to when
 * passthrough is taken. Same path as the gateway's inbound route in every
 * case — that's what makes the fast-path "passthrough" rather than
 * "rewrite": we forward the bytes to the same logical endpoint on the real
 * provider, with `Authorization` swapped.
 */
const FORMAT_TO_UPSTREAM_PATH: Record<string, string> = {
	"openai-chat": "/v1/chat/completions",
	"anthropic-messages": "/v1/messages",
	"openai-responses": "/v1/responses",
};

/**
 * Inbound format → set of model.api values where a 1:1 byte passthrough is
 * legal. When the inbound format matches the model's native API, we skip the
 * translate/rebuild round-trip and forward the request body unchanged with
 * `Authorization` rewritten. Two big wins:
 *   - prompt caching hints (`cache_control`, etc.) flow through to upstream
 *     intact; the gateway no longer breaks anthropic prompt-caching;
 *   - provider-specific options (`metadata`, `service_tier`, `tool_choice`
 *     extensions, …) work without per-field allowlist maintenance here.
 *
 * `openai-codex-responses` is deliberately absent — codex runs over a
 * websocket transport that has no equivalent inbound shape, so it always
 * takes the translate path.
 */
const FORMAT_TO_PASSTHROUGH_API: Record<string, ReadonlySet<Api>> = {
	"openai-chat": new Set(["openai-completions"]),
	"anthropic-messages": new Set(["anthropic-messages"]),
	"openai-responses": new Set(["openai-responses"]),
};

/**
 * Hop-by-hop headers per RFC 7230. Stripped from both the inbound (so we don't
 * forward the client's `Authorization` containing only the gateway bearer) and
 * the upstream response (so we don't pass `Transfer-Encoding: chunked` back
 * after we've already buffered).
 */
const HOP_BY_HOP_HEADERS = new Set<string>([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// Codex backend rejects `temperature` / `top_p` (per-model defaults only),
	// so we drop them silently for that one provider. Every other unsupported
	// option is just ignored by `streamSimple` if the underlying provider
	// doesn't honour it.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined) opts.topK = options.topK;
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice === "object" ? { type: "tool", name: options.toolChoice.name } : options.toolChoice;
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.presencePenalty !== undefined) opts.presencePenalty = options.presencePenalty;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.thinkingBudget !== undefined) {
		// Anthropic gives a single budget number with no effort label; bridge it
		// to pi-ai's per-level map and default the level to "high" so providers
		// that key off `reasoning` actually surface the budget.
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), [Effort.High]: options.thinkingBudget };
		opts.reasoning ??= Effort.High;
	}
	return opts;
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

function clientClosedResponse(): Response {
	return json(499, { error: "client closed request" });
}

/**
 * 1:1 byte passthrough fast-path. When the inbound format matches the model's
 * native API (per {@link FORMAT_TO_PASSTHROUGH_API}), we skip parse + translate
 * + re-emit and forward the request body as-is to the upstream provider with
 * `Authorization` rewritten to the real access token. Provider-specific
 * features (anthropic prompt caching, openai `service_tier`, tool-choice
 * extensions, …) pass through unchanged.
 *
 * `body` is the already-parsed JSON; we re-serialize it to bytes for the
 * upstream request. Re-serialization is intentional — Bun's `Request#json()`
 * consumes the underlying stream, so the original bytes aren't available
 * anyway, and any client-side whitespace/key-order difference is irrelevant
 * to every provider this gateway targets.
 */
async function handlePassthrough(
	route: { module: FormatModule; label: string },
	model: Model<Api>,
	body: unknown,
	apiKey: string,
	req: Request,
	peer: string,
	signal: AbortSignal,
): Promise<Response> {
	const wirePath = FORMAT_TO_UPSTREAM_PATH[route.label];
	if (!wirePath) {
		// Shouldn't happen — caller already confirmed FORMAT_TO_PASSTHROUGH_API
		// has an entry for this label, which implies a wire path exists.
		return json(500, { error: `No upstream wire path for format ${route.label}` });
	}
	const baseUrl = model.baseUrl.replace(/\/+$/, "");
	const upstreamUrl = `${baseUrl}${wirePath}`;

	const upstreamHeaders = new Headers();
	req.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		// Strip every header the client uses to identify itself to the gateway.
		// The gateway is the only thing that should be telling the upstream
		// provider who's calling; the client's bearer (or anthropic's `x-api-key`,
		// which omp's own anthropic provider always sends alongside `Authorization`)
		// is just access control INTO the gateway and would otherwise leak to
		// upstream as a 401-inducing bogus credential.
		if (lower === "authorization" || lower === "x-api-key") return;
		if (lower === "host" || lower === "content-length") return;
		if (HOP_BY_HOP_HEADERS.has(lower)) return;
		upstreamHeaders.set(key, value);
	});
	upstreamHeaders.set("Authorization", `Bearer ${apiKey}`);

	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl, {
			method: req.method,
			headers: upstreamHeaders,
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (signal.aborted) return clientClosedResponse();
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("auth-gateway passthrough upstream failed", {
			format: route.label,
			provider: model.provider,
			model: model.id,
			upstream: upstreamUrl,
			peer,
			error: message,
		});
		return json(502, { error: message });
	}

	logger.info("auth-gateway passthrough", {
		format: route.label,
		provider: model.provider,
		model: model.id,
		upstream: upstreamUrl,
		status: upstream.status,
		peer,
	});

	// Pass body straight through without buffering. Strip hop-by-hop headers
	// from upstream, plus `content-encoding` and `content-length`: Bun's
	// `fetch` transparently decodes gzip/br/deflate bodies but leaves the
	// `Content-Encoding` header intact — forwarding it makes the client try to
	// re-decode plain bytes and crash with `ZlibError`. `content-length` is
	// stale too once Bun re-frames the response.
	const outboundHeaders = new Headers();
	upstream.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower)) return;
		if (lower === "content-encoding" || lower === "content-length") return;
		outboundHeaders.set(key, value);
	});
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: outboundHeaders,
	});
}

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse();
		return json(400, { error: `Invalid JSON body: ${String(error)}` });
	}
	if (controller.signal.aborted) return clientClosedResponse();

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the passthrough
	// fast-path doesn't block on provider-specific fields the schema would
	// otherwise reject (anthropic `metadata`, openai `service_tier`, …).
	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return json(400, { error: "Missing top-level `model` field" });
	}

	const model = bootOpts.resolveModel(modelId);
	if (!model) {
		return json(404, { error: `Unknown model: ${modelId}` });
	}

	// pi-ai's stream() does NOT consult AuthStorage — the caller (us) is
	// expected to resolve the credential and pass it as `options.apiKey`.
	// For OAuth providers this returns the access token (refreshed via the
	// broker override on AuthStorage when needed).
	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, undefined, { modelId: model.id });
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse();
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: message });
		return json(502, { error: message });
	}
	if (controller.signal.aborted) return clientClosedResponse();
	if (!apiKey) {
		return json(401, { error: `No credential available for provider ${model.provider}` });
	}

	// Fast path: 1:1 byte passthrough when the inbound format matches the
	// model's native API. Skips schema validation entirely — provider-specific
	// fields (prompt caching, service tier, …) flow through unchanged.
	const passthroughApis = FORMAT_TO_PASSTHROUGH_API[route.label];
	if (passthroughApis?.has(model.api)) {
		return handlePassthrough(route, model, body, apiKey, req, peer, controller.signal);
	}

	// Translate path: parse + validate against the strict format schema,
	// rebuild as omp's canonical Context, dispatch through pi-ai's
	// streamSimple, encode the canonical event stream back to the inbound
	// format. Used when the inbound wire format and the selected model's
	// native API differ (e.g. /v1/chat/completions targeting an Anthropic
	// model, or /v1/responses targeting openai-codex over websocket).
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return json(400, { error: message });
	}
	if (controller.signal.aborted) return clientClosedResponse();

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
	streamOpts.apiKey = apiKey;

	logger.info("auth-gateway request", {
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return clientClosedResponse();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("auth-gateway streamSimple threw", { format: route.label, error: message, peer });
		return json(502, { error: message });
	}

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return clientClosedResponse();
			const message = await events.result();
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: route.label,
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				return json(message.stopReason === "aborted" ? 499 : 502, { error: errorMessage });
			}
			return json(200, route.module.encodeResponse(message, parsed.modelId));
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse();
			const errMsg = error instanceof Error ? error.message : String(error);
			logger.warn("auth-gateway non-streaming aborted", { format: route.label, error: errMsg, peer });
			return json(502, { error: errMsg });
		}
	}
	if (controller.signal.aborted) return clientClosedResponse();

	const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options);
	return new Response(sseStream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

/**
 * Snapshot of `GET /v1/usage` — fetchUsageReports already caches reports at 30s TTL
 * inside AuthStorage, so this handler is a thin wrapper that surfaces the same
 * data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.()) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const list = opts.listModels ? Array.from(opts.listModels()) : [];
	const data = list.map(model => ({
		id: model.id,
		object: "model" as const,
		owned_by: model.provider,
		api: model.api,
	}));
	return json(200, { object: "list", data });
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return json(200, { ok: true, version });
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					return json(401, { error: "unauthorized" });
				}

				// Aggregated usage — backed by AuthStorage's 30s cache. Same shape as
				// the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					return await handleUsage(opts.storage);
				}

				// Provider-format dispatch.
				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					return await handleFormatEndpoint(formatRoute, opts, req, peer);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					return handleModelsList(opts);
				}

				return json(404, { error: `No route: ${req.method} ${pathname}` });
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
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
			server.stop(true);
		},
	};
}
