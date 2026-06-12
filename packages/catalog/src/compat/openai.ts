/**
 * OpenAI-API compat builders — chat-completions and Responses flavors.
 *
 * `buildOpenAICompat`/`buildOpenAIResponsesCompat` run exactly once per model
 * (from `buildModel`): detection writes a fresh record, sparse spec overrides
 * are assigned onto it in place, and conditional policies are materialized as
 * complete alternate views. Request handlers read `model.compat` fields and
 * never detect, resolve, or allocate.
 */
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
import type { ModelSpec, OpenAICompat, ResolvedOpenAICompat, ResolvedOpenAIResponsesCompat } from "../types";
import { applyCompatOverrides } from "./apply";

/** GLM coding-plan SKUs idle for minutes mid-reasoning; see `streamIdleTimeoutMs`. */
const GLM_CODING_PLAN_MODEL_PATTERN = /^glm-5(?:[.-]|$)/i;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
/** Direct DeepSeek reasoning models stall between thinking and answer phases. */
const DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * OpenCode's gateways (https://opencode.ai/zen|go) gate `reasoning_content`
 * on the request's thinking state for every model they front (Kimi K2.x,
 * DeepSeek V4, GLM-5.x, Qwen3.x, MiMo, MiniMax, …): they 400 with `Extra
 * inputs are not permitted` when thinking is off but the field is supplied
 * (#1071), and 400 with `thinking is enabled but reasoning_content is missing
 * in assistant tool call message at index N` (#1484) when thinking is on and
 * the field is absent. The base compat therefore leaves the replay off, and
 * this `whenThinking` policy reactivates it for thinking-engaged requests.
 * `allowsSyntheticReasoningContentForToolCalls` is forced to `false` on the
 * same path: the gateway specifically requires `reasoning_content`, and the
 * synthetic-friendly default would echo whichever field the upstream streamed
 * (e.g. `reasoning` for many opencode turns), landing the replay in the wrong
 * key and re-triggering the 400.
 */
const OPENCODE_WHEN_THINKING: NonNullable<OpenAICompat["whenThinking"]> = {
	requiresReasoningContentForToolCalls: true,
	allowsSyntheticReasoningContentForToolCalls: false,
	reasoningContentField: "reasoning_content",
};

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

/**
 * Build the resolved chat-completions compat record for a model spec.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 */
export function buildOpenAICompat(spec: ModelSpec<"openai-completions">): ResolvedOpenAICompat {
	const provider = spec.provider;
	const baseUrl = spec.baseUrl;
	const hostModel = { provider, baseUrl };

	const isCerebras = modelMatchesHost(hostModel, "cerebras");
	const isZai = modelMatchesHost(hostModel, "zai");
	const isZhipu = modelMatchesHost(hostModel, "zhipu");
	const isKilo = modelMatchesHost(hostModel, "kilo");
	const isKimiModel = isKimiModelId(spec.id);
	const isMoonshotNative = modelMatchesHost(hostModel, "moonshotNative");
	const isMoonshotKimi = isKimiModel && isMoonshotNative;
	const usesMoonshotKimiPreservedThinking = isMoonshotKimi && isKimiK26ModelId(spec.id);
	const isAnthropicModel =
		modelMatchesHost(hostModel, "anthropic") || isClaudeModelId(spec.id) || isAnthropicNamespacedModelId(spec.id);
	const isAlibaba = modelMatchesHost(hostModel, "alibabaDashscope");
	const isNvidiaNim = modelMatchesHost(hostModel, "nvidia");
	const isQwen = isQwenModelId(spec.id);
	// DeepSeek V4 (and other reasoning-capable DeepSeek models) reject follow-up requests in
	// thinking mode unless prior assistant tool-call turns include `reasoning_content`. The
	// upstream model is reachable through many OpenAI-compat hosts (api.deepseek.com, Deepinfra,
	// Kilo, NVIDIA NIM, Zenmux, OpenRouter, …), so we match by model id/name as well as by
	// provider/baseUrl. The flag is gated by `spec.reasoning` because the invariant only
	// applies when thinking mode is actually engaged.
	const lowerId = spec.id.toLowerCase();
	const lowerName = (spec.name ?? "").toLowerCase();
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isXiaomiMimo = isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));
	// OpenCode Zen's `big-pickle` is a DeepSeek reasoning alias; the upstream
	// 400s come from DeepSeek and require exact reasoning_content replay.
	const isOpenCodeDeepseekAlias =
		provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	const isDeepseekFamily =
		modelMatchesHost(hostModel, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(spec.name ?? "") ||
		isOpenCodeDeepseekAlias;
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	const isDirectDeepseekReasoning = isDirectDeepseekApi && isDeepseekFamily && Boolean(spec.reasoning);
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
		isMoonshotNative ||
		isOpenCodeHost;
	const isOpenCodeProvider = provider === "opencode-go" || provider === "opencode-zen";

	const useMaxTokens =
		isMistral ||
		isMoonshotNative ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isDirectDeepseekApi;

	// Hosts whose chat-completions endpoints are known to accept multiple
	// leading `system`/`developer` messages (preferred for KV-cache reuse).
	// Anything outside this allowlist defaults to coalescing because
	// strict chat templates (Qwen 3.5+ via vLLM, MiniMax, etc.) reject
	// follow-up system messages with a 400.
	const isOpenAIHost = modelMatchesHost(hostModel, "openai");
	const isAzureHost = modelMatchesHost(hostModel, "azureOpenAI");
	const isOpenRouter = modelMatchesHost(hostModel, "openrouter");
	const isVercelGateway = modelMatchesHost(hostModel, "vercelAIGateway");
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

	// Stream-watchdog floor: GLM coding-plan SKUs and direct DeepSeek reasoning
	// models idle for minutes mid-reasoning; widen the idle timeout so warm-ups
	// stop aborting and retrying.
	const streamIdleTimeoutMs =
		GLM_CODING_PLAN_MODEL_PATTERN.test(spec.id) && (isZai || isZhipu)
			? GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
			: spec.reasoning && isDirectDeepseekApi
				? DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS
				: undefined;

	const compat: ResolvedOpenAICompat = {
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
		// GitHub Copilot's chat-completions endpoint rejects reasoning params wholesale.
		supportsReasoningParams: provider !== "github-copilot",
		reasoningEffortMap: {},
		supportsUsageInStreaming: !isCerebras,
		// Kimi (including via OpenRouter and Fireworks router-form IDs such as
		// `accounts/fireworks/routers/kimi-*`) calculates TPM rate limits based on
		// max_tokens, not actual output. The official Kimi K2 model guidance
		// (https://docs.fireworks.ai/models/kimi-k2) also requires `max_tokens` for
		// every call since the family can otherwise emit very long reasoning traces
		// before the final answer.
		alwaysSendMaxTokens: isKimiModel,
		disableReasoningOnForcedToolChoice: isKimiModel || isAnthropicModel,
		disableReasoningOnToolChoice: isDeepseekFamily && Boolean(spec.reasoning) && !isOpenRouter,
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
		// NVIDIA NIM hosts Qwen with the vLLM convention
		// (`chat_template_kwargs.enable_thinking`); top-level `enable_thinking`
		// is rejected by NIM's `additionalProperties: false` request schema
		// (issue #2299).
		thinkingFormat:
			isZai || isZhipu || isMoonshotKimi || isXiaomiMimo
				? "zai"
				: isOpenRouter
					? "openrouter"
					: isQwen && isNvidiaNim
						? "qwen-chat-template"
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
		// client-sent `reasoning_content`, so exclude only that Kimi-on-OpenCode path
		// (the `whenThinking` policy below re-enables the replay for thinking turns).
		requiresReasoningContentForToolCalls:
			(isKimiModel && !isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(spec.reasoning)) ||
			isXiaomiMimo ||
			(isOpenRouter && Boolean(spec.reasoning)),
		// DeepSeek V4 and Xiaomi MiMo reject synthetic reasoning_content placeholders (".") on tool-call turns.
		// Kimi and OpenRouter accept them when actual reasoning is unavailable.
		allowsSyntheticReasoningContentForToolCalls: (!isDeepseekFamily || !spec.reasoning) && !isXiaomiMimo,
		requiresAssistantContentForToolCalls: isKimiModel || isDirectDeepseekReasoning,
		cacheControlFormat: isOpenRouter && spec.id.startsWith("anthropic/") ? "anthropic" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		isVercelGatewayHost: isVercelGateway,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: isDirectDeepseekReasoning ? { thinking: { type: "enabled" } } : undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",
		streamIdleTimeoutMs,
	};

	applyCompatOverrides(compat, spec.compat);

	const whenThinkingPolicy =
		spec.compat?.whenThinking ?? (isOpenCodeProvider && spec.reasoning ? OPENCODE_WHEN_THINKING : undefined);
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat };
		applyCompatOverrides(variant, whenThinkingPolicy);
		compat.whenThinking = variant;
	}

	return compat;
}

interface OpenAIResponsesSpecLike {
	provider: string;
	name: string;
	baseUrl: string;
	compat?: OpenAICompat;
}

/**
 * Build the resolved Responses-API compat record. The Responses flavor
 * deliberately differs from chat-completions: GitHub Copilot's responses
 * endpoint accepts the `developer` role, while strict tool mode is scoped to
 * first-party OpenAI/Azure/Copilot providers. Developer-role and prompt-cache
 * detection are URL-only on purpose — the historical call sites never
 * consulted the provider id for them. The GPT-5 juice-zero hack keys on the
 * model name, matching the historical request-time check.
 */
export function buildOpenAIResponsesCompat(spec: OpenAIResponsesSpecLike): ResolvedOpenAIResponsesCompat {
	const baseUrl = spec.baseUrl ?? "";
	const compat: ResolvedOpenAIResponsesCompat = {
		supportsDeveloperRole:
			hostMatchesUrl(baseUrl, "openai") ||
			hostMatchesUrl(baseUrl, "azureOpenAI") ||
			hostMatchesUrl(baseUrl, "githubCopilot"),
		supportsStrictMode:
			spec.provider === "openai" ||
			spec.provider === "azure" ||
			spec.provider === "github-copilot" ||
			hostMatchesUrl(baseUrl, "openai") ||
			hostMatchesUrl(baseUrl, "azureOpenAI"),
		supportsReasoningEffort: true,
		supportsLongPromptCacheRetention: hostMatchesUrl(baseUrl, "openai"),
		// Azure OpenAI and GitHub Copilot Responses paths require tool results
		// to strictly match prior tool calls when building Responses inputs.
		strictResponsesPairing: hostMatchesUrl(baseUrl, "azureOpenAI") || spec.provider === "github-copilot",
		requiresJuiceZeroHack: spec.name.toLowerCase().startsWith("gpt-5"),
		reasoningEffortMap: {},
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
