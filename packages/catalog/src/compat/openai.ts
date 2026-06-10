import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import {
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isKimiK26ModelId,
	isKimiModelId,
	isMimoModelIdOrName,
	isQwenModelId,
} from "../identity/family";
import type { Model, OpenAICompat } from "../types";

type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

export type ResolvedOpenAICompat = Required<
	Omit<
		OpenAICompat,
		| "openRouterRouting"
		| "vercelGatewayRouting"
		| "extraBody"
		| "toolStrictMode"
		| "streamIdleTimeoutMs"
		| "supportsLongPromptCacheRetention"
		| "cacheControlFormat"
		| "thinkingKeep"
	>
> & {
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
	extraBody?: OpenAICompat["extraBody"];
	cacheControlFormat?: OpenAICompat["cacheControlFormat"];
	thinkingKeep?: OpenAICompat["thinkingKeep"];
	streamIdleTimeoutMs?: number;
	toolStrictMode: ResolvedToolStrictMode;
};

/** GLM coding-plan SKUs idle for minutes mid-reasoning; see `streamIdleTimeoutMs`. */
const GLM_CODING_PLAN_MODEL_PATTERN = /^glm-5(?:[.-]|$)/i;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
/** Direct DeepSeek reasoning models stall between thinking and answer phases. */
const DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;

function detectStrictModeSupport(provider: string, baseUrl: string): boolean {
	if (
		provider === "openai" ||
		provider === "openrouter" ||
		provider === "cerebras" ||
		provider === "together" ||
		provider === "github-copilot" ||
		provider === "zenmux"
	) {
		return true;
	}
	return (
		hostMatchesUrl(baseUrl, "openai") ||
		hostMatchesUrl(baseUrl, "azureOpenAI") ||
		hostMatchesUrl(baseUrl, "cerebras") ||
		hostMatchesUrl(baseUrl, "together") ||
		hostMatchesUrl(baseUrl, "openrouter") ||
		hostMatchesUrl(baseUrl, "deepseekFamily")
	);
}

function getOpenRouterAnthropicReasoningEffortMap(
	modelId: string,
): Partial<Record<OpenAIReasoningEffort, string>> | undefined {
	const match = /(?:^|\/)claude-(opus|fable|mythos)-(\d{1,2})(?:[.-](\d{1,2}))?/.exec(modelId);
	if (!match) return undefined;

	const kind = match[1];
	const major = Number(match[2]);
	const minor = Number(match[3] ?? 0);
	const isFableOrMythos = kind === "fable" || kind === "mythos";
	const isOpusAdaptive = kind === "opus" && (major > 4 || (major === 4 && minor >= 6));
	if (!isFableOrMythos && !isOpusAdaptive) return undefined;

	const hasRealXHigh = isFableOrMythos || major > 4 || (major === 4 && minor >= 7);
	if (hasRealXHigh) {
		return {
			minimal: "low",
			low: "medium",
			medium: "high",
			high: "xhigh",
			xhigh: "max",
		};
	}
	return {
		minimal: "low",
		xhigh: "max",
	};
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * @param model - The model configuration
 * @param resolvedBaseUrl - Optional resolved base URL (e.g., after GitHub Copilot proxy-ep resolution).
 *                           If provided, this takes precedence over model.baseUrl for URL-based checks.
 */
export function detectOpenAICompat(model: Model<"openai-completions">, resolvedBaseUrl?: string): ResolvedOpenAICompat {
	const provider = model.provider;
	// Use resolvedBaseUrl if provided (e.g., after GitHub Copilot proxy-ep resolution)
	const baseUrl = resolvedBaseUrl ?? model.baseUrl;
	const hostModel = { provider, baseUrl };

	const isCerebras = modelMatchesHost(hostModel, "cerebras");
	const isZai = modelMatchesHost(hostModel, "zai");
	const isZhipu = modelMatchesHost(hostModel, "zhipu");
	const isKilo = modelMatchesHost(hostModel, "kilo");
	const isKimiModel = isKimiModelId(model.id);
	const isMoonshotKimi = isKimiModel && modelMatchesHost(hostModel, "moonshotNative");
	const usesMoonshotKimiPreservedThinking = isMoonshotKimi && isKimiK26ModelId(model.id);
	const isAnthropicModel =
		modelMatchesHost(hostModel, "anthropic") || isClaudeModelId(model.id) || isAnthropicNamespacedModelId(model.id);
	const isAlibaba = modelMatchesHost(hostModel, "alibabaDashscope");
	const isQwen = isQwenModelId(model.id);
	// DeepSeek V4 (and other reasoning-capable DeepSeek models) reject follow-up requests in
	// thinking mode unless prior assistant tool-call turns include `reasoning_content`. The
	// upstream model is reachable through many OpenAI-compat hosts (api.deepseek.com, Deepinfra,
	// Kilo, NVIDIA NIM, Zenmux, OpenRouter, …), so we match by model id/name as well as by
	// provider/baseUrl. The flag is gated by `model.reasoning` because the invariant only
	// applies when thinking mode is actually engaged.
	const lowerId = model.id.toLowerCase();
	const lowerName = (model.name ?? "").toLowerCase();
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isXiaomiMimo = isXiaomiHost && (isMimoModelIdOrName(model.id) || isMimoModelIdOrName(model.name ?? ""));
	// OpenCode Zen's `big-pickle` is a DeepSeek reasoning alias; the upstream
	// 400s come from DeepSeek and require exact reasoning_content replay.
	const isOpenCodeDeepseekAlias =
		provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	const isDeepseekFamily =
		modelMatchesHost(hostModel, "deepseekFamily") ||
		isDeepseekModelIdOrName(model.id) ||
		isDeepseekModelIdOrName(model.name ?? "") ||
		isOpenCodeDeepseekAlias;
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	const isDirectDeepseekReasoning = isDirectDeepseekApi && isDeepseekFamily && Boolean(model.reasoning);
	const isGrok = modelMatchesHost(hostModel, "xai");
	const isMistral = modelMatchesHost(hostModel, "mistral");
	const isOpenCodeHost = modelMatchesHost(hostModel, "opencode");
	const isNonStandard =
		isCerebras ||
		isGrok ||
		isMistral ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "deepseekFamily") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isAlibaba ||
		isZai ||
		isZhipu ||
		isKilo ||
		isQwen ||
		isXiaomiHost ||
		isOpenCodeHost;
	const isOpenCodeProvider = provider === "opencode-go" || provider === "opencode-zen";

	const useMaxTokens =
		isMistral || hostMatchesUrl(baseUrl, "chutes") || hostMatchesUrl(baseUrl, "fireworks") || isDirectDeepseekApi;

	// Hosts whose chat-completions endpoints are known to accept multiple
	// leading `system`/`developer` messages (preferred for KV-cache reuse).
	// Anything outside this allowlist defaults to coalescing because
	// strict chat templates (Qwen 3.5+ via vLLM, MiniMax, etc.) reject
	// follow-up system messages with a 400.
	const isOpenAIHost = modelMatchesHost(hostModel, "openai");
	const isAzureHost = modelMatchesHost(hostModel, "azureOpenAI");
	const isOpenRouter = modelMatchesHost(hostModel, "openrouter");
	const isTogether = modelMatchesHost(hostModel, "together");
	const isFireworks = hostMatchesUrl(baseUrl, "fireworks");
	const isGroqHost = modelMatchesHost(hostModel, "groq");
	const isCopilotHost = provider === "github-copilot";
	const isZenmuxHost = provider === "zenmux";
	// Endpoints that MUST receive a single system block. MiniMax's OpenAI
	// endpoint returns error 2013 on multiple system messages; Alibaba's
	// Dashscope and Qwen Portal serve Qwen models whose chat template
	// raises "System message must be at the beginning" if any system
	// message appears past index 0.
	const isMiniMaxHost = modelMatchesHost(hostModel, "minimax");
	const isQwenPortal = modelMatchesHost(hostModel, "qwenPortal");
	const supportsMultipleSystemMessagesDefault =
		!isMiniMaxHost &&
		!isAlibaba &&
		!isQwenPortal &&
		(isOpenAIHost ||
			isAzureHost ||
			isOpenRouter ||
			isCerebras ||
			isTogether ||
			isFireworks ||
			isGroqHost ||
			isDeepseekFamily ||
			isMistral ||
			isGrok ||
			isZai ||
			isZhipu ||
			isCopilotHost ||
			isZenmuxHost);

	const openRouterAnthropicReasoningEffortMap = isOpenRouter
		? getOpenRouterAnthropicReasoningEffortMap(lowerId)
		: undefined;
	const reasoningEffortMap: NonNullable<OpenAICompat["reasoningEffortMap"]> =
		provider === "groq" && model.id === "qwen/qwen3-32b"
			? ({
					minimal: "default",
					low: "default",
					medium: "default",
					high: "default",
					xhigh: "default",
				} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
			: isDeepseekFamily && model.reasoning
				? ({
						minimal: "high",
						low: "high",
						medium: "high",
						high: "high",
						xhigh: "max",
					} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
				: openRouterAnthropicReasoningEffortMap
					? openRouterAnthropicReasoningEffortMap
					: isFireworks
						? ({
								// Fireworks' OpenAI-compatible endpoint rejects OpenAI's
								// `minimal` literal but accepts `none` for the lowest setting.
								minimal: "none",
							} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
						: {};

	// Stream-watchdog floor: GLM coding-plan SKUs and direct DeepSeek reasoning
	// models idle for minutes mid-reasoning; widen the idle timeout so warm-ups
	// stop aborting and retrying.
	const streamIdleTimeoutMs =
		GLM_CODING_PLAN_MODEL_PATTERN.test(model.id) && (isZai || isZhipu)
			? GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
			: model.reasoning && isDirectDeepseekApi
				? DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS
				: undefined;

	return {
		supportsStore: !isNonStandard,
		// `developer` is an OpenAI-Responses-era extension to the chat-completions schema. Almost
		// every OpenAI-compatible host other than OpenAI itself (and Azure OpenAI, which mirrors
		// the schema exactly) treats it as an unknown role: Moonshot returns a 400 "tokenization
		// failed", Groq/Cerebras/etc. error or silently misroute. Default to `system` and require
		// callers to opt in via `compat.supportsDeveloperRole: true` for hosts known to mirror
		// OpenAI's reasoning-API surface.
		supportsDeveloperRole: isOpenAIHost || isAzureHost,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesDefault,
		supportsReasoningEffort: !isGrok && !isZai && !isZhipu && !isXiaomiMimo,
		reasoningEffortMap,
		supportsUsageInStreaming: !isCerebras,
		disableReasoningOnForcedToolChoice: isKimiModel || isAnthropicModel,
		disableReasoningOnToolChoice: isDeepseekFamily && Boolean(model.reasoning) && !isOpenRouter,
		supportsToolChoice: !isDirectDeepseekReasoning,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
		// Only Kimi's native hosts (Moonshot / Kimi-code, matched by `isMoonshotKimi`)
		// speak the z.ai binary `thinking: { type }` field. Kimi reached through
		// OpenAI-compatible proxies — Fireworks' Fire Pass router, OpenCode's gateway,
		// etc. — drives reasoning via OpenAI-style `reasoning_effort`
		// (low|medium|high|xhigh|max|none), so those stay on the "openai" path.
		thinkingFormat:
			isZai || isZhipu || isMoonshotKimi || isXiaomiMimo
				? "zai"
				: isOpenRouter
					? "openrouter"
					: isAlibaba || isQwen
						? "qwen"
						: "openai",
		thinkingKeep: usesMoonshotKimiPreservedThinking ? "all" : undefined,
		reasoningContentField: "reasoning_content",
		// Backends that 400 follow-up requests when prior assistant tool-call turns lack `reasoning_content`:
		//   - Kimi: documented invariant on its native API.
		//   - DeepSeek-family reasoning models, including aliased OpenCode Zen models
		//     like `big-pickle`, validate exact thinking-mode replay.
		//   - Xiaomi MiMo models require exact `reasoning_content` replay on
		//     thinking-mode tool-call continuations across standard and Token Plan hosts.
		//   - Any reasoning-capable model reached through OpenRouter can enforce this
		//     server-side whenever the request is in thinking mode. We can't translate
		//     Anthropic's redacted/encrypted reasoning into provider-native plaintext,
		//     so cross-provider continuations rely on a placeholder.
		// OpenCode Kimi aliases handle reasoning content internally and reject
		// client-sent `reasoning_content`, so exclude only that Kimi-on-OpenCode path.
		requiresReasoningContentForToolCalls:
			(isKimiModel && !isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(model.reasoning)) ||
			isXiaomiMimo ||
			(isOpenRouter && Boolean(model.reasoning)),
		// DeepSeek V4 and Xiaomi MiMo reject synthetic reasoning_content placeholders (".") on tool-call turns.
		// Kimi and OpenRouter accept them when actual reasoning is unavailable.
		allowsSyntheticReasoningContentForToolCalls: (!isDeepseekFamily || !model.reasoning) && !isXiaomiMimo,
		requiresAssistantContentForToolCalls: isKimiModel || isDirectDeepseekReasoning,
		cacheControlFormat: isOpenRouter && model.id.startsWith("anthropic/") ? "anthropic" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: isDirectDeepseekReasoning ? { thinking: { type: "enabled" } } : undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",
		streamIdleTimeoutMs,
	};
}

/**
 * Resolve compatibility settings by layering explicit model.compat overrides onto
 * the detected defaults. This is the canonical compat view for both metadata and transport.
 * @param model - The model configuration
 * @param resolvedBaseUrl - Optional resolved base URL (e.g., after GitHub Copilot proxy-ep resolution).
 *                           If provided, this takes precedence over model.baseUrl for URL-based checks.
 */
export function resolveOpenAICompat(
	model: Model<"openai-completions">,
	resolvedBaseUrl?: string,
): ResolvedOpenAICompat {
	const detected = detectOpenAICompat(model, resolvedBaseUrl);
	if (!model.compat) {
		return detected;
	}

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsMultipleSystemMessages:
			model.compat.supportsMultipleSystemMessages ?? detected.supportsMultipleSystemMessages,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		reasoningEffortMap: { ...detected.reasoningEffortMap, ...(model.compat.reasoningEffortMap ?? {}) },
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsToolChoice: model.compat.supportsToolChoice ?? detected.supportsToolChoice,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresMistralToolIds: model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		thinkingKeep: model.compat.thinkingKeep ?? detected.thinkingKeep,
		reasoningContentField: model.compat.reasoningContentField ?? detected.reasoningContentField,
		requiresReasoningContentForToolCalls:
			model.compat.requiresReasoningContentForToolCalls ?? detected.requiresReasoningContentForToolCalls,
		allowsSyntheticReasoningContentForToolCalls:
			model.compat.allowsSyntheticReasoningContentForToolCalls ??
			detected.allowsSyntheticReasoningContentForToolCalls,
		requiresAssistantContentForToolCalls:
			model.compat.requiresAssistantContentForToolCalls ?? detected.requiresAssistantContentForToolCalls,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		disableReasoningOnForcedToolChoice:
			model.compat.disableReasoningOnForcedToolChoice ?? detected.disableReasoningOnForcedToolChoice,
		disableReasoningOnToolChoice: model.compat.disableReasoningOnToolChoice ?? detected.disableReasoningOnToolChoice,
		openRouterRouting: model.compat.openRouterRouting ?? detected.openRouterRouting,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		extraBody: model.compat.extraBody ?? detected.extraBody,
		toolStrictMode: model.compat.toolStrictMode ?? detected.toolStrictMode,
		streamIdleTimeoutMs: model.compat.streamIdleTimeoutMs ?? detected.streamIdleTimeoutMs,
	};
}

/** Resolved Responses-API compatibility view (see `detectOpenAIResponsesCompat`). */
export interface ResolvedOpenAIResponsesCompat {
	supportsDeveloperRole: boolean;
	supportsStrictMode: boolean;
	supportsLongPromptCacheRetention: boolean;
}

/**
 * Detect Responses-API compatibility from provider/baseUrl. The Responses
 * flavor deliberately differs from chat-completions: GitHub Copilot's
 * responses endpoint accepts the `developer` role, while strict tool mode is
 * scoped to first-party OpenAI/Azure/Copilot providers. Developer-role and
 * prompt-cache detection are URL-only on purpose — the historical call sites
 * never consulted the provider id for them.
 */
export function detectOpenAIResponsesCompat(
	model: { provider: string; baseUrl: string },
	resolvedBaseUrl?: string,
): ResolvedOpenAIResponsesCompat {
	const baseUrl = resolvedBaseUrl ?? model.baseUrl ?? "";
	return {
		supportsDeveloperRole:
			hostMatchesUrl(baseUrl, "openai") ||
			hostMatchesUrl(baseUrl, "azureOpenAI") ||
			hostMatchesUrl(baseUrl, "githubCopilot"),
		supportsStrictMode:
			model.provider === "openai" ||
			model.provider === "azure" ||
			model.provider === "github-copilot" ||
			hostMatchesUrl(baseUrl, "openai") ||
			hostMatchesUrl(baseUrl, "azureOpenAI"),
		supportsLongPromptCacheRetention: hostMatchesUrl(baseUrl, "openai"),
	};
}

/**
 * Resolve Responses-API compatibility by layering explicit `model.compat`
 * overrides onto the detected defaults — the Responses-side analogue of
 * `resolveOpenAICompat`. Models bundled with `supportsDeveloperRole: false`
 * (codex-mini-style SKUs) take effect here.
 */
export function resolveOpenAIResponsesCompat(
	model: { provider: string; baseUrl: string; compat?: OpenAICompat },
	resolvedBaseUrl?: string,
): ResolvedOpenAIResponsesCompat {
	const detected = detectOpenAIResponsesCompat(model, resolvedBaseUrl);
	const compat = model.compat;
	if (!compat) return detected;
	return {
		supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsLongPromptCacheRetention:
			compat.supportsLongPromptCacheRetention ?? detected.supportsLongPromptCacheRetention,
	};
}
