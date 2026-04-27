import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as tls from "node:tls";
import Anthropic, { type ClientOptions as AnthropicSdkClientOptions } from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import { $env, abortableSleep, isEnoent } from "@oh-my-pi/pi-utils";
import { hasOpus47ApiRestrictions, mapEffortToAnthropicAdaptiveEffort } from "../model-thinking";
import { calculateCost } from "../models";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	RedactedThinkingContent,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types";
import { isAnthropicOAuthToken, isRecord, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import { createWatchdog, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { parseStreamingJson } from "../utils/json-parse";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { notifyProviderResponse } from "../utils/provider-response";
import { extractHttpStatusFromError, isCopilotRetryableError } from "../utils/retry";
import { COMBINATOR_KEYS, NO_STRICT } from "../utils/schema";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { transformMessages } from "./transform-messages";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
};

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

// Build deduplicated beta header string
export function buildBetaHeader(baseBetas: string[], extraBetas: string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

const claudeCodeBetaDefaults = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
];
function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

function isAnthropicApiBaseUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	try {
		const url = new URL(baseUrl);
		return url.protocol.toLowerCase() === "https:" && url.hostname.toLowerCase() === "api.anthropic.com";
	} catch {
		return false;
	}
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"Anthropic-Version": "2023-06-01",
	"Anthropic-Dangerous-Direct-Browser-Access": "true",
	"X-App": "cli",
};

export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;
	const betaHeader = buildBetaHeader(claudeCodeBetaDefaults, extraBetas);
	const acceptHeader = stream ? "text/event-stream" : "application/json";
	const modelHeaders = Object.fromEntries(
		Object.entries(options.modelHeaders ?? {}).filter(([key]) => !enforcedHeaderKeys.has(key.toLowerCase())),
	);

	if (oauthToken) {
		const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
			? incomingUserAgent
			: `claude-cli/${claudeCodeVersion} (external, cli)`;
		return {
			...modelHeaders,
			...claudeCodeHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"User-Agent": userAgent,
		};
	} else if (!isAnthropicApiBaseUrl(options.baseUrl)) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"X-Api-Key": options.apiKey,
		};
	}
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };

type AnthropicSamplingParams = MessageCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
};

/**
 * Adaptive thinking `display` is supported starting with Claude Opus 4.7.
 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field.
 */
function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	const match = /claude-opus-(\d+)-(\d+)/.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 4 || (major === 4 && minor >= 7);
}

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
};

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		close: () => {
			state.strictToolsDisabled = false;
		},
	};
	return state;
}

function getAnthropicProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): AnthropicProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(ANTHROPIC_PROVIDER_SESSION_STATE_KEY) as
		| AnthropicProviderSessionState
		| undefined;
	if (existing) return existing;
	const created = createAnthropicProviderSessionState();
	providerSessionState.set(ANTHROPIC_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

function isAnthropicStrictGrammarTooLargeError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	const message = error instanceof Error ? error.message : String(error);
	const isStrictGrammarTooLarge = /compiled grammar/i.test(message) && /too large/i.test(message);
	const isSchemaCompilationTooComplex =
		/schema/i.test(message) && /too complex/i.test(message) && /compil/i.test(message);
	return /invalid_request_error/i.test(message) && (isStrictGrammarTooLarge || isSchemaCompilationTooComplex);
}

function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	const tools = params.tools as Array<{ strict?: unknown }> | undefined;
	return tools?.some(tool => tool.strict === true) ?? false;
}

function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	const tools = params.tools as Array<{ strict?: unknown }> | undefined;
	if (!tools) return;
	for (const tool of tools) {
		delete tool.strict;
	}
}

function getCacheControl(
	baseUrl: string,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: AnthropicCacheControl } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code headers and tool prefixing.
export const claudeCodeVersion = "2.1.63";
export const claudeToolPrefix: string = "proxy_";
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

export const claudeCodeHeaders = {
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.3.0",
	"X-Stainless-Package-Version": "0.74.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Os": mapStainlessOs(process.platform),
	"X-Stainless-Timeout": "600",
} as const;

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(claudeCodeHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"Anthropic-Version",
		"Anthropic-Dangerous-Direct-Browser-Access",
		"Anthropic-Beta",
		"User-Agent",
		"X-App",
		"Authorization",
		"X-Api-Key",
	].map(key => key.toLowerCase()),
);

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function createClaudeBillingHeader(payload: unknown): string {
	const payloadJson = JSON.stringify(payload) ?? "";
	const cch = nodeCrypto.createHash("sha256").update(payloadJson).digest("hex").slice(0, 5);
	const randomBytes = new Uint8Array(2);
	crypto.getRandomValues(randomBytes);
	const buildHash = Array.from(randomBytes, byte => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 3);
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

function resolveAnthropicMetadataUserId(userId: unknown, isOAuthToken: boolean): string | undefined {
	if (typeof userId === "string") {
		if (!isOAuthToken || isClaudeCloakingUserId(userId)) {
			return userId;
		}
	}

	if (!isOAuthToken) return undefined;
	return generateClaudeCloakingUserId();
}
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set(["web_search", "code_execution", "text_editor", "computer"]);
export const applyClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
	const prefix = prefixOverride.toLowerCase();
	if (name.toLowerCase().startsWith(prefix)) return name;
	return `${prefixOverride}${name}`;
};

export const stripClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	const prefix = prefixOverride.toLowerCase();
	if (!name.toLowerCase().startsWith(prefix)) return name;
	return name.slice(prefixOverride.length);
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some(c => c.type === "image");
	if (!hasImages) {
		return content
			.map(c => (c as TextContent).text)
			.join("\n")
			.toWellFormed();
	}

	// If we have images, convert to content block array
	const blocks = content.map(block => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: block.text.toWellFormed(),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some(b => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6+: uses adaptive thinking (Claude decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6+ which uses adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ only).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Optional reasoning level fallback for direct Anthropic provider usage.
	 * Converted to adaptive effort when effort is not explicitly provided.
	 */
	reasoning?: SimpleStreamOptions["reasoning"];
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;
	/** Force OAuth bearer auth mode for proxy tokens that don't match Anthropic token prefixes. */
	isOAuth?: boolean;
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

export type AnthropicClientOptionsArgs = {
	model: Model<"anthropic-messages">;
	apiKey: string;
	extraBetas?: string[];
	stream?: boolean;
	interleavedThinking?: boolean;
	headers?: Record<string, string>;
	dynamicHeaders?: Record<string, string>;
	isOAuth?: boolean;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string;
	baseURL?: string;
	maxRetries: number;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders: Record<string, string>;
	logLevel: AnthropicSdkClientOptions["logLevel"];
	fetchOptions?: AnthropicSdkClientOptions["fetchOptions"];
};

const CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (model.provider === "anthropic" && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) {
			return foundryBaseUrl;
		}
	}
	if (model.provider === "anthropic") {
		return normalizeAnthropicBaseUrl(model.baseUrl) ?? "https://api.anthropic.com";
	}
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function parseAnthropicCustomHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
	const source = rawHeaders?.trim();
	if (!source) return undefined;

	const parsed: Record<string, string> = {};
	for (const token of source.split(/\r?\n|,/)) {
		const entry = token.trim();
		if (!entry) continue;
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) continue;
		parsed[key] = value;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function resolveAnthropicCustomHeaders(model: Model<"anthropic-messages">): Record<string, string> | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;
	return parseAnthropicCustomHeaders($env.ANTHROPIC_CUSTOM_HEADERS);
}

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer|key)$/i.test(value);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new Error("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = [...tls.rootCertificates, ca];
	if (cert) options.cert = cert;
	if (key) options.key = key;
	return Object.keys(options).length > 0 ? options : undefined;
}

function buildClaudeCodeTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicSdkClientOptions["fetchOptions"] | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(CLAUDE_CODE_TLS_CIPHERS ? { ciphers: CLAUDE_CODE_TLS_CIPHERS } : {}),
			...(foundryTlsOptions ?? {}),
		},
	};
}
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

// The Anthropic SDK logs malformed SSE frames directly before rethrowing them.
// We surface the resulting provider error ourselves, so keep the SDK quiet.
const ANTHROPIC_SDK_LOG_LEVEL = "off" as const;

const PROVIDER_MAX_RETRIES = 3;
const PROVIDER_BASE_DELAY_MS = 2000;

/**
 * Check if an error from the Anthropic SDK is a rate-limit/transient error that
 * should be retried before any content has been emitted.
 *
 * Includes malformed JSON stream-envelope parse errors seen from some
 * Anthropic-compatible proxy endpoints.
 */
/** Transient stream corruption errors where the response was truncated mid-JSON. */
function isTransientStreamParseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /json parse error|unterminated string|unexpected end of json input/i.test(error.message);
}

const ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

function createAnthropicStreamEnvelopeError(message: string): Error {
	return new Error(`${ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX} ${message}`);
}

const ANTHROPIC_PRE_MESSAGE_START_EVENT_TYPES = new Set([
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
	"message_start",
]);

function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
	if (typeof eventType !== "string") return false;
	if (eventType === "ping") return true;
	return !ANTHROPIC_PRE_MESSAGE_START_EVENT_TYPES.has(eventType);
}

function isTransientStreamEnvelopeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.includes(ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX) ||
		/stream event order|before message_start|before terminal stop signal/i.test(error.message)
	);
}

function isProviderRetryableStreamEnvelopeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /stream event order|before message_start/i.test(error.message);
}

export function isProviderRetryableError(error: unknown, provider?: string): boolean {
	if (!(error instanceof Error)) return false;
	if (provider === "github-copilot" && isCopilotRetryableError(error)) return true;
	const msg = error.message.toLowerCase();
	return (
		/rate.?limit|too many requests|overloaded|service.?unavailable|internal_error|stream error.*received from peer|1302|timed?\s*out while waiting for the first event|timeout waiting for first/i.test(
			msg,
		) ||
		isTransientStreamParseError(error) ||
		isProviderRetryableStreamEnvelopeError(error)
	);
}

function createEmptyUsage(premiumRequests?: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...(premiumRequests === undefined ? {} : { premiumRequests }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type AnthropicUsageLike = {
	cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
	server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

/**
 * Capture Anthropic's optional cache-creation TTL breakdown and server-tool-use
 * counters into the harness Usage shape. Only sets fields that were reported, so
 * a `message_delta` that omits `cache_creation` does not clobber the breakdown
 * established at `message_start`.
 */
export function applyAnthropicUsageExtras(usage: Usage, source: AnthropicUsageLike): void {
	const cacheCreation = source.cache_creation;
	if (cacheCreation) {
		const fiveMinute = cacheCreation.ephemeral_5m_input_tokens ?? 0;
		const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			usage.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		}
	}
	const serverToolUse = source.server_tool_use;
	if (serverToolUse) {
		const webSearch = serverToolUse.web_search_requests ?? 0;
		const webFetch = serverToolUse.web_fetch_requests ?? 0;
		if (webSearch > 0 || webFetch > 0) {
			usage.server = {
				...(webSearch > 0 ? { webSearch } : {}),
				...(webFetch > 0 ? { webFetch } : {}),
			};
		}
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const copilotDynamicHeaders =
			model.provider === "github-copilot"
				? buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages: hasCopilotVisionInput(context.messages),
						premiumMultiplier: model.premiumMultiplier,
						headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
						initiatorOverride: options?.initiatorOverride,
					})
				: undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(copilotDynamicHeaders?.premiumRequests),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		try {
			let client: Anthropic;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";

				const created = createClient(model, {
					model,
					apiKey,
					extraBetas: normalizeExtraBetas(options?.betas),
					stream: true,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
				});
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			const baseUrl =
				resolveAnthropicBaseUrl(model, options?.apiKey ?? getEnvApiKey(model.provider) ?? "") ??
				"https://api.anthropic.com";
			const providerSessionState = getAnthropicProviderSessionState(options?.providerSessionState);
			let disableStrictTools = providerSessionState?.strictToolsDisabled ?? false;
			let strictFallbackErrorMessage: string | undefined;
			const prepareParams = async (): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(model, baseUrl, context, isOAuthToken, options, disableStrictTools);
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				if (disableStrictTools) {
					dropAnthropicStrictTools(nextParams);
				}
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages`,
					body: nextParams,
				};
				return nextParams;
			};
			let params = await prepareParams();

			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| (ToolCall & { partialJson: string })
			) & { index: number };
			const blocks = output.content as Block[];
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs();
			stream.push({ type: "start", partial: output });
			// Retry loop for transient errors from the stream.
			// Provider-level transport/rate-limit failures: only before any streamed content starts.
			// Malformed envelopes/JSON: only before replay-unsafe text/tool events are visible on this stream.
			let providerRetryAttempt = 0;
			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const firstEventTimeoutAbortError = new Error(
					"Anthropic stream timed out while waiting for the first event",
				);
				const { requestSignal } = activeAbortTracker;
				const anthropicRequest = client.messages.create({ ...params, stream: true }, { signal: requestSignal });
				let streamedReplayUnsafeContent = false;

				try {
					const { data: anthropicStream, response, request_id } = await anthropicRequest.withResponse();
					await notifyProviderResponse(options, response, model, request_id);
					const firstEventWatchdog = createWatchdog(firstEventTimeoutMs, () =>
						activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
					);
					let sawEvent = false;
					let sawMessageStart = false;
					let sawTerminalEnvelope = false;

					for await (const event of anthropicStream) {
						if (!sawEvent) {
							clearTimeout(firstEventWatchdog);
						}
						sawEvent = true;

						if (event.type === "message_start") {
							if (sawMessageStart) {
								continue;
							}
							sawMessageStart = true;
							applyAnthropicUsageExtras(output.usage, event.message.usage);
							output.responseId = event.message.id;
							output.usage.input = event.message.usage.input_tokens || 0;
							output.usage.output = event.message.usage.output_tokens || 0;
							output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
							output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							continue;
						}

						if (!sawMessageStart) {
							if (shouldIgnoreAnthropicPreambleEvent(event.type)) {
								continue;
							}
							throw createAnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
						}

						if (event.type === "content_block_start") {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (event.content_block.type === "text") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "text",
									text: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "text_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "thinking") {
								const block: Block = {
									type: "thinking",
									thinking: "",
									thinkingSignature: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "redacted_thinking") {
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									index: event.index,
								};
								output.content.push(block);
							} else if (event.content_block.type === "tool_use") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: isOAuthToken
										? stripClaudeToolPrefix(event.content_block.name)
										: event.content_block.name,
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
						} else if (event.type === "content_block_delta") {
							if (event.delta.type === "text_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "text") {
									block.text += event.delta.text;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: event.delta.text,
										partial: output,
									});
								}
							} else if (event.delta.type === "thinking_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinking += event.delta.thinking;
									stream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: event.delta.thinking,
										partial: output,
									});
								}
							} else if (event.delta.type === "input_json_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parseStreamingJson(block.partialJson);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: event.delta.partial_json,
										partial: output,
									});
								}
							} else if (event.delta.type === "signature_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinkingSignature = block.thinkingSignature || "";
									block.thinkingSignature += event.delta.signature;
								}
							}
						} else if (event.type === "content_block_stop") {
							const index = blocks.findIndex(b => b.index === event.index);
							const block = blocks[index];
							if (block) {
								delete (block as { index?: number }).index;
								if (block.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: output,
									});
								} else if (block.type === "thinking") {
									stream.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: output,
									});
								} else if (block.type === "toolCall") {
									block.arguments = parseStreamingJson(block.partialJson);
									delete (block as { partialJson?: string }).partialJson;
									stream.push({
										type: "toolcall_end",
										contentIndex: index,
										toolCall: block,
										partial: output,
									});
								}
							}
						} else if (event.type === "message_delta") {
							if (event.delta.stop_reason) {
								output.stopReason = mapStopReason(event.delta.stop_reason);
								sawTerminalEnvelope = true;
							}
							if (event.usage.input_tokens != null) {
								output.usage.input = event.usage.input_tokens;
							}
							if (event.usage.output_tokens != null) {
								output.usage.output = event.usage.output_tokens;
							}
							if (event.usage.cache_read_input_tokens != null) {
								output.usage.cacheRead = event.usage.cache_read_input_tokens;
							}
							if (event.usage.cache_creation_input_tokens != null) {
								output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
							}
							applyAnthropicUsageExtras(output.usage, event.usage);
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
						} else if (event.type === "message_stop") {
							sawTerminalEnvelope = true;
						}
					}

					const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
					if (firstEventTimeoutError) {
						throw firstEventTimeoutError;
					}
					if (activeAbortTracker.wasCallerAbort()) {
						throw new Error("Request was aborted");
					}
					if (!sawEvent || !sawMessageStart) {
						throw createAnthropicStreamEnvelopeError("stream ended before message_start");
					}
					if (!sawTerminalEnvelope) {
						throw createAnthropicStreamEnvelopeError("stream ended before terminal stop signal");
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new Error("An unknown error occurred");
					}
					break;
				} catch (streamError) {
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					if (
						!disableStrictTools &&
						firstTokenTime === undefined &&
						hasStrictAnthropicTools(params) &&
						isAnthropicStrictGrammarTooLargeError(streamFailure)
					) {
						strictFallbackErrorMessage = await finalizeErrorMessage(streamFailure, rawRequestDump);
						output.errorMessage = strictFallbackErrorMessage;
						if (providerSessionState) {
							providerSessionState.strictToolsDisabled = true;
						}
						disableStrictTools = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.responseId = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					const isTransientEnvelopeFailure =
						isTransientStreamParseError(streamFailure) || isTransientStreamEnvelopeError(streamFailure);
					const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !streamedReplayUnsafeContent;
					const canRetryProviderFailure =
						firstTokenTime === undefined && isProviderRetryableError(streamFailure, model.provider);
					if (
						activeAbortTracker.wasCallerAbort() ||
						providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
						(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
					) {
						throw streamFailure;
					}
					providerRetryAttempt++;
					const delayMs = PROVIDER_BASE_DELAY_MS * 2 ** (providerRetryAttempt - 1);
					await abortableSleep(delayMs, options?.signal);
					output.content.length = 0;
					output.responseId = undefined;
					output.errorMessage = strictFallbackErrorMessage;
					output.providerPayload = undefined;
					output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
					output.stopReason = "stop";
					firstTokenTime = undefined;
				}
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
			output.stopReason = activeAbortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];
	billingPayload?: unknown;
	cacheControl?: AnthropicCacheControl;
};

export function buildAnthropicSystemBlocks(
	systemPrompt: string | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction = false, extraInstructions = [], billingPayload, cacheControl } = options;
	const blocks: AnthropicSystemBlock[] = [];
	const sanitizedPrompt = systemPrompt ? systemPrompt.toWellFormed() : "";
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompt.includes(CLAUDE_BILLING_HEADER_PREFIX);

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const payloadSeed = billingPayload ?? {
			system: sanitizedPrompt,
			extraInstructions: trimmedInstructions,
		};
		blocks.push(
			{ type: "text", text: createClaudeBillingHeader(payloadSeed) },
			{
				type: "text",
				text: claudeCodeSystemInstruction,
			},
		);
	}

	for (const instruction of trimmedInstructions) {
		blocks.push({
			type: "text",
			text: instruction,
			...(cacheControl ? { cache_control: cacheControl } : {}),
		});
	}

	if (systemPrompt) {
		blocks.push({
			type: "text",
			text: sanitizedPrompt,
			...(cacheControl ? { cache_control: cacheControl } : {}),
		});
	}

	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		isOAuth,
	} = args;
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinkingDisplay(model.id);
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model);
	const tlsFetchOptions = buildClaudeCodeTlsFetchOptions(model, baseUrl);
	if (model.provider === "github-copilot") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;
		const betaFeatures = [...extraBetas];
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
		};
	}

	const betaFeatures = [...extraBetas];
	if (needsInterleavedBeta) {
		betaFeatures.push("interleaved-thinking-2025-05-14");
	}

	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: mergeHeaders(model.headers, foundryCustomHeaders, headers, dynamicHeaders),
	});

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
		logLevel: ANTHROPIC_SDK_LOG_LEVEL,
		...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: Anthropic; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new Anthropic(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(params: MessageCreateParamsStreaming): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type === "any" || toolChoice.type === "tool") {
		delete params.thinking;
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, model: Model<"anthropic-messages">): void {
	const thinking = params.thinking;
	if (!thinking || thinking.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const maxTokens = params.max_tokens ?? 0;
	const requiredMaxTokens = budgetTokens + OUTPUT_FALLBACK_BUFFER;
	if (maxTokens < requiredMaxTokens) {
		params.max_tokens = Math.min(requiredMaxTokens, model.maxTokens);
	}
}

type CacheControlBlock = {
	cache_control?: AnthropicCacheControl | null;
};

function applyCacheControlToLastBlock<T extends CacheControlBlock>(
	blocks: T[],
	cacheControl: AnthropicCacheControl,
): void {
	if (blocks.length === 0) return;
	const lastIndex = blocks.length - 1;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cacheControl };
}

function applyCacheControlToLastTextBlock(
	blocks: Array<ContentBlockParam & CacheControlBlock>,
	cacheControl: AnthropicCacheControl,
): void {
	if (blocks.length === 0) return;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].type === "text") {
			blocks[i] = { ...blocks[i], cache_control: cacheControl };
			return;
		}
	}
	applyCacheControlToLastBlock(blocks, cacheControl);
}

function applyPromptCaching(params: MessageCreateParamsStreaming, cacheControl?: AnthropicCacheControl): void {
	if (!cacheControl) return;

	// Skip if cache_control breakpoints were already placed externally on messages.
	for (const message of params.messages) {
		if (Array.isArray(message.content)) {
			if ((message.content as Array<ContentBlockParam & CacheControlBlock>).some(b => b.cache_control != null))
				return;
		}
	}

	const MAX_CACHE_BREAKPOINTS = 4;
	let cacheBreakpointsUsed = 0;

	if (params.tools && params.tools.length > 0) {
		applyCacheControlToLastBlock(params.tools as Array<CacheControlBlock>, cacheControl);
		cacheBreakpointsUsed++;
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	if (params.system && Array.isArray(params.system) && params.system.length > 0) {
		applyCacheControlToLastBlock(params.system, cacheControl);
		cacheBreakpointsUsed++;
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	const userIndexes = params.messages
		.map((message, index) => (message.role === "user" ? index : -1))
		.filter(index => index >= 0);

	if (userIndexes.length >= 2) {
		const penultimateUserIndex = userIndexes[userIndexes.length - 2];
		const penultimateUser = params.messages[penultimateUserIndex];
		if (penultimateUser) {
			if (typeof penultimateUser.content === "string") {
				const contentBlock: ContentBlockParam & CacheControlBlock = {
					type: "text",
					text: penultimateUser.content,
					cache_control: cacheControl,
				};
				penultimateUser.content = [contentBlock];
				cacheBreakpointsUsed++;
			} else if (Array.isArray(penultimateUser.content) && penultimateUser.content.length > 0) {
				applyCacheControlToLastTextBlock(
					penultimateUser.content as Array<ContentBlockParam & CacheControlBlock>,
					cacheControl,
				);
				cacheBreakpointsUsed++;
			}
		}
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	if (userIndexes.length >= 1) {
		const lastUserIndex = userIndexes[userIndexes.length - 1];
		const lastUser = params.messages[lastUserIndex];
		if (lastUser) {
			if (typeof lastUser.content === "string") {
				const contentBlock: ContentBlockParam & CacheControlBlock = {
					type: "text",
					text: lastUser.content,
					cache_control: cacheControl,
				};
				lastUser.content = [contentBlock];
			} else if (Array.isArray(lastUser.content) && lastUser.content.length > 0) {
				applyCacheControlToLastTextBlock(
					lastUser.content as Array<ContentBlockParam & CacheControlBlock>,
					cacheControl,
				);
			}
		}
	}
}

function normalizeCacheControlBlockTtl(block: CacheControlBlock, seenFiveMinute: { value: boolean }): void {
	const cacheControl = block.cache_control;
	if (!cacheControl) return;
	if (cacheControl.ttl !== "1h") {
		seenFiveMinute.value = true;
		return;
	}
	if (seenFiveMinute.value) {
		delete cacheControl.ttl;
	}
}

function normalizeCacheControlTtlOrdering(params: MessageCreateParamsStreaming): void {
	const seenFiveMinute = { value: false };
	if (params.tools) {
		for (const tool of params.tools as Array<Anthropic.Messages.Tool & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(tool, seenFiveMinute);
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
}

function findLastCacheControlIndex<T extends CacheControlBlock>(blocks: T[]): number {
	for (let index = blocks.length - 1; index >= 0; index--) {
		if (blocks[index]?.cache_control != null) return index;
	}
	return -1;
}

function stripCacheControlExceptIndex<T extends CacheControlBlock>(
	blocks: T[],
	preserveIndex: number,
	excessCounter: { value: number },
): void {
	for (let index = 0; index < blocks.length && excessCounter.value > 0; index++) {
		if (index === preserveIndex) continue;
		if (!blocks[index]?.cache_control) continue;
		delete blocks[index].cache_control;
		excessCounter.value--;
	}
}

function stripAllCacheControl<T extends CacheControlBlock>(blocks: T[], excessCounter: { value: number }): void {
	for (const block of blocks) {
		if (excessCounter.value <= 0) return;
		if (!block.cache_control) continue;
		delete block.cache_control;
		excessCounter.value--;
	}
}

function stripMessageCacheControl(
	messages: MessageCreateParamsStreaming["messages"],
	excessCounter: { value: number },
): void {
	for (const message of messages) {
		if (excessCounter.value <= 0) return;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (excessCounter.value <= 0) return;
			if (!block.cache_control) continue;
			delete block.cache_control;
			excessCounter.value--;
		}
	}
}

function countCacheControlBreakpoints(params: MessageCreateParamsStreaming): number {
	let total = 0;
	if (params.tools) {
		for (const tool of params.tools as Array<Anthropic.Messages.Tool & CacheControlBlock>) {
			if (tool.cache_control) total++;
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	return total;
}

function enforceCacheControlLimit(params: MessageCreateParamsStreaming, maxBreakpoints: number): void {
	const total = countCacheControlBreakpoints(params);
	if (total <= maxBreakpoints) return;
	const excessCounter = { value: total - maxBreakpoints };
	const systemBlocks =
		params.system && Array.isArray(params.system)
			? (params.system as Array<AnthropicSystemBlock & CacheControlBlock>)
			: [];
	const toolBlocks = (params.tools ?? []) as Array<Anthropic.Messages.Tool & CacheControlBlock>;
	const lastSystemIndex = findLastCacheControlIndex(systemBlocks);
	const lastToolIndex = findLastCacheControlIndex(toolBlocks);
	if (systemBlocks.length > 0) {
		stripCacheControlExceptIndex(systemBlocks, lastSystemIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripCacheControlExceptIndex(toolBlocks, lastToolIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	stripMessageCacheControl(params.messages, excessCounter);
	if (excessCounter.value <= 0) return;
	if (systemBlocks.length > 0) {
		stripAllCacheControl(systemBlocks, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripAllCacheControl(toolBlocks, excessCounter);
	}
}
function buildParams(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disableStrictTools = false,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(baseUrl, options?.cacheRetention);
	const params: AnthropicSamplingParams = {
		model: model.id,
		messages: convertAnthropicMessages(context.messages, model, isOAuthToken),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}

	// Opus 4.7+ rejects non-default sampling parameters with 400 error.
	if (hasOpus47ApiRestrictions(model.id)) {
		delete params.top_p;
		delete params.top_k;
	}

	if (context.tools) {
		params.tools = convertTools(
			context.tools,
			isOAuthToken,
			disableStrictTools || model.provider === "github-copilot",
		);
	}

	if (options?.thinkingEnabled && model.reasoning) {
		const mode = model.thinking?.mode;
		const requestedEffort = options.reasoning;
		const effort =
			options.effort ?? (requestedEffort ? mapEffortToAnthropicAdaptiveEffort(model, requestedEffort) : undefined);

		if (mode === "anthropic-adaptive") {
			// Starting with Claude Opus 4.7, adaptive thinking content is omitted from the
			// response by default. Opt into summarized reasoning so thinking deltas keep
			// streaming with human-readable content for callers that rely on it.
			const adaptive: { type: "adaptive"; display?: "summarized" | "omitted" } = { type: "adaptive" };
			if (supportsAdaptiveThinkingDisplay(model.id)) {
				adaptive.display = "summarized";
			}
			params.thinking = adaptive as typeof params.thinking;
			if (effort) {
				// SDK's OutputConfig.effort type is not yet widened to include the new "xhigh"
				// level introduced with Claude Opus 4.7. Cast until the SDK catches up.
				params.output_config = { effort } as typeof params.output_config;
			}
		} else {
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
			};
			if (mode === "anthropic-budget-effort" && effort) {
				params.output_config = { effort } as typeof params.output_config;
			}
		}
	}

	const metadataUserId = resolveAnthropicMetadataUserId(options?.metadata?.user_id, isOAuthToken);
	if (metadataUserId) {
		params.metadata = { user_id: metadataUserId };
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (isOAuthToken && options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: applyClaudeToolPrefix(options.toolChoice.name),
			};
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const billingPayload = shouldInjectClaudeCodeInstruction
		? {
				...params,
				...(context.systemPrompt ? { system: context.systemPrompt.toWellFormed() } : {}),
			}
		: undefined;
	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		billingPayload,
	});
	if (systemBlocks) {
		params.system = systemBlocks;
	}
	disableThinkingIfToolChoiceForced(params);
	ensureMaxTokensForThinking(params, model);
	applyPromptCaching(params, cacheControl);
	enforceCacheControlLimit(params, 4);
	normalizeCacheControlTtlOrdering(params);

	return params;
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
): MessageParam[] {
	const params: MessageParam[] = [];

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user" || msg.role === "developer") {
			if (!msg.content) continue;

			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: msg.content.toWellFormed(),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map(item => {
					if (item.type === "text") {
						return {
							type: "text",
							text: item.text.toWellFormed(),
						};
					}
					return {
						type: "image",
						source: {
							type: "base64",
							media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
							data: item.data,
						},
					};
				});
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter(b => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter(b => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: block.thinking.toWellFormed(),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({
							type: "text",
							text: block.thinking.toWellFormed(),
						});
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? applyClaudeToolPrefix(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

const ANTHROPIC_UNSUPPORTED_TOOL_SCHEMA_FIELDS = new Set(["maxItems", "patternProperties"]);
const ANTHROPIC_STRICT_TOOL_ALLOWLIST = new Set(["bash", "python", "edit", "find"]);
const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;

/** `minItems` / `maxItems` apply to arrays; Anthropic rejects them on `type: "object"` (including `minItems: 0`/`1`). */
function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	return false;
}

function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

function normalizeAnthropicToolSchema(
	schema: unknown,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): unknown {
	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	const result = Object.fromEntries(
		Object.entries(schema).filter(([key]) => !ANTHROPIC_UNSUPPORTED_TOOL_SCHEMA_FIELDS.has(key)),
	);
	cache.set(schema, result);
	if (isJsonSchemaObjectNode(result)) {
		delete result.minItems;
	} else {
		const minItems = result.minItems;
		if (typeof minItems === "number" && minItems !== 0 && minItems !== 1) {
			delete result.minItems;
		}
	}

	const type = result.type;
	const canBeObject =
		type === "object" || (Array.isArray(type) && type.includes("object")) || isRecord(result.properties);
	if (canBeObject) {
		result.additionalProperties = false;
	}

	if (isRecord(result.properties)) {
		result.properties = Object.fromEntries(
			Object.entries(result.properties).map(([propertyName, propertySchema]) => [
				propertyName,
				normalizeAnthropicToolSchema(propertySchema, cache),
			]),
		);
	}

	if (Array.isArray(result.items)) {
		result.items = result.items.map(item => normalizeAnthropicToolSchema(item, cache));
	} else if (isRecord(result.items)) {
		result.items = normalizeAnthropicToolSchema(result.items, cache);
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (Array.isArray(variants)) {
			result[key] = variants.map(variant => normalizeAnthropicToolSchema(variant, cache));
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		result[defsKey] = Object.fromEntries(
			Object.entries(definitions).map(([definitionName, definitionSchema]) => [
				definitionName,
				normalizeAnthropicToolSchema(definitionSchema, cache),
			]),
		);
	}

	return result;
}

type AnthropicToolInputSchema = Anthropic.Messages.Tool["input_schema"];

type AnthropicToolSchemaPlan = {
	inputSchema: AnthropicToolInputSchema;
	strict: boolean;
};

type AnthropicStrictBudget = {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
};

function hasAnthropicUnionType(schema: Record<string, unknown>): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(variant => isRecord(variant) && variant.type === "null");
}

function makeAnthropicNullableSchema(schema: unknown, budget: AnthropicStrictBudget): unknown | undefined {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) {
			return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		}
		if (Array.isArray(schema.type)) {
			return { ...schema, type: [...schema.type, "null"] };
		}
	}

	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function normalizeAnthropicStrictSchemaNode(
	schema: unknown,
	budget: AnthropicStrictBudget,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): unknown | undefined {
	if (Array.isArray(schema)) {
		const result: unknown[] = [];
		for (const entry of schema) {
			const normalized = normalizeAnthropicStrictSchemaNode(entry, budget, cache);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}

	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	const result: Record<string, unknown> = { ...schema };
	cache.set(schema, result);

	if (hasAnthropicUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}

	if (isRecord(result.properties)) {
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const [propertyName, propertySchema] of Object.entries(result.properties)) {
			const normalizedProperty = normalizeAnthropicStrictSchemaNode(propertySchema, budget, cache);
			if (normalizedProperty === undefined) return undefined;

			if (originalRequired.has(propertyName)) {
				properties[propertyName] = normalizedProperty;
				required.push(propertyName);
				continue;
			}

			if (budget.optionalRemaining > 0) {
				budget.optionalRemaining--;
				budget.optionalCount++;
				properties[propertyName] = normalizedProperty;
				continue;
			}

			const nullableProperty = makeAnthropicNullableSchema(normalizedProperty, budget);
			if (nullableProperty === undefined) return undefined;
			properties[propertyName] = nullableProperty;
			required.push(propertyName);
		}

		result.properties = properties;
		result.required = required;
	}

	if (Array.isArray(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	} else if (isRecord(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (!Array.isArray(variants)) continue;
		const normalizedVariants = normalizeAnthropicStrictSchemaNode(variants, budget, cache);
		if (normalizedVariants === undefined) return undefined;
		result[key] = normalizedVariants;
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefinitions: Record<string, unknown> = {};
		for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
			const normalizedDefinition = normalizeAnthropicStrictSchemaNode(definitionSchema, budget, cache);
			if (normalizedDefinition === undefined) return undefined;
			normalizedDefinitions[definitionName] = normalizedDefinition;
		}
		result[defsKey] = normalizedDefinitions;
	}

	return result;
}

function normalizeAnthropicStrictSchema(
	schema: Record<string, unknown>,
	optionalRemaining: number,
	unionRemaining: number,
): { schema: Record<string, unknown>; optionalCount: number; unionCount: number } | undefined {
	const budget: AnthropicStrictBudget = {
		optionalRemaining,
		unionRemaining,
		optionalCount: 0,
		unionCount: 0,
	};
	const normalized = normalizeAnthropicStrictSchemaNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

function buildAnthropicBaseToolInputSchema(tool: Tool): Record<string, unknown> {
	const jsonSchema = tool.parameters as Record<string, unknown>;
	return normalizeAnthropicToolSchema({
		...jsonSchema,
		type: "object",
		properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
		required: Array.isArray(jsonSchema.required)
			? jsonSchema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	}) as Record<string, unknown>;
}

function buildAnthropicToolSchemaPlans(tools: Tool[], disableStrictTools = false): AnthropicToolSchemaPlan[] {
	const plans = tools.map(
		(tool): AnthropicToolSchemaPlan => ({
			inputSchema: buildAnthropicBaseToolInputSchema(tool) as AnthropicToolInputSchema,
			strict: false,
		}),
	);
	if (NO_STRICT || disableStrictTools) return plans;

	const candidateIndexes = tools.flatMap((tool, index) => {
		if (!ANTHROPIC_STRICT_TOOL_ALLOWLIST.has(tool.name)) return [];
		return tool.strict === false ? [] : [index];
	});

	let strictToolCount = 0;
	let strictOptionalParameterCount = 0;
	let strictUnionParameterCount = 0;
	for (const index of candidateIndexes) {
		if (strictToolCount >= MAX_ANTHROPIC_STRICT_TOOLS) break;

		const strictResult = normalizeAnthropicStrictSchema(
			plans[index].inputSchema as Record<string, unknown>,
			MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS - strictOptionalParameterCount,
			MAX_ANTHROPIC_STRICT_UNION_PARAMETERS - strictUnionParameterCount,
		);
		if (!strictResult) continue;

		plans[index] = {
			inputSchema: strictResult.schema as AnthropicToolInputSchema,
			strict: true,
		};
		strictToolCount++;
		strictOptionalParameterCount += strictResult.optionalCount;
		strictUnionParameterCount += strictResult.unionCount;
	}

	return plans;
}

function convertTools(tools: Tool[], isOAuthToken: boolean, disableStrictTools = false): Anthropic.Messages.Tool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		return {
			name: isOAuthToken ? applyClaudeToolPrefix(tool.name) : tool.name,
			description: tool.description || "",
			input_schema: plan.inputSchema,
			...(plan.strict ? { strict: true } : {}),
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
