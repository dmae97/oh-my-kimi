import type { Model, OpenAICompat } from "../types";

type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

export type ResolvedOpenAICompat = Required<
	Omit<OpenAICompat, "openRouterRouting" | "vercelGatewayRouting" | "extraBody" | "toolStrictMode">
> & {
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
	extraBody?: OpenAICompat["extraBody"];
	toolStrictMode: ResolvedToolStrictMode;
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

	const normalizedBaseUrl = baseUrl.toLowerCase();
	return (
		normalizedBaseUrl.includes("api.openai.com") ||
		normalizedBaseUrl.includes(".openai.azure.com") ||
		normalizedBaseUrl.includes("models.inference.ai.azure.com") ||
		normalizedBaseUrl.includes("api.cerebras.ai") ||
		normalizedBaseUrl.includes("api.together.xyz") ||
		normalizedBaseUrl.includes("openrouter.ai") ||
		normalizedBaseUrl.includes("api.deepseek.com") ||
		normalizedBaseUrl.includes("deepseek.com")
	);
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

	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
	const isKilo = provider === "kilo" || baseUrl.includes("api.kilo.ai");
	const isKimiModel = model.id.includes("moonshotai/kimi") || /^kimi[-.]/i.test(model.id);
	const isAlibaba = provider === "alibaba-coding-plan" || baseUrl.includes("dashscope");
	const isQwen = model.id.toLowerCase().includes("qwen");
	// DeepSeek V4 (and other reasoning-capable DeepSeek models) reject follow-up requests in
	// thinking mode unless prior assistant tool-call turns include `reasoning_content`. The
	// upstream model is reachable through many OpenAI-compat hosts (api.deepseek.com, Deepinfra,
	// Kilo, NVIDIA NIM, Zenmux, OpenRouter, …), so we match by model id/name as well as by
	// provider/baseUrl. The flag is gated by `model.reasoning` because the invariant only
	// applies when thinking mode is actually engaged.
	const lowerId = model.id.toLowerCase();
	const lowerName = (model.name ?? "").toLowerCase();
	const isDeepseekFamily =
		provider === "deepseek" ||
		baseUrl.includes("deepseek.com") ||
		lowerId.includes("deepseek") ||
		lowerName.includes("deepseek");

	const isNonStandard =
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		provider === "mistral" ||
		baseUrl.includes("mistral.ai") ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("deepseek.com") ||
		baseUrl.includes("fireworks.ai") ||
		isAlibaba ||
		isZai ||
		isKilo ||
		isQwen ||
		provider === "opencode-zen" ||
		provider === "opencode-go" ||
		baseUrl.includes("opencode.ai");

	const useMaxTokens =
		provider === "mistral" ||
		baseUrl.includes("mistral.ai") ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("fireworks.ai");
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isMistral = provider === "mistral" || baseUrl.includes("mistral.ai");

	const reasoningEffortMap: NonNullable<OpenAICompat["reasoningEffortMap"]> =
		provider === "groq" && model.id === "qwen/qwen3-32b"
			? ({
					minimal: "default",
					low: "default",
					medium: "default",
					high: "default",
					xhigh: "default",
				} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
			: {};

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: !isNonStandard,
		supportsReasoningEffort: !isGrok && !isZai,
		reasoningEffortMap,
		supportsUsageInStreaming: !isCerebras,
		supportsToolChoice: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
		thinkingFormat: isZai
			? "zai"
			: provider === "openrouter" || baseUrl.includes("openrouter.ai")
				? "openrouter"
				: isAlibaba || isQwen
					? "qwen"
					: "openai",
		reasoningContentField: "reasoning_content",
		// Backends that 400 follow-up requests when prior assistant tool-call turns lack `reasoning_content`:
		//   - Kimi: documented invariant on its native API and via OpenCode-Go.
		//   - Any reasoning-capable model reached through OpenRouter: DeepSeek V4 Pro and similar enforce
		//     this server-side whenever the request is in thinking mode. We can't translate Anthropic's
		//     redacted/encrypted reasoning into DeepSeek's plaintext form, so cross-provider continuations
		//     rely on a placeholder — see `convertMessages` for the placeholder injection.
		requiresReasoningContentForToolCalls:
			isKimiModel ||
			(isDeepseekFamily && Boolean(model.reasoning)) ||
			((provider === "openrouter" || baseUrl.includes("openrouter.ai")) && Boolean(model.reasoning)),
		requiresAssistantContentForToolCalls: isKimiModel,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",
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
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		reasoningEffortMap: model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsToolChoice: model.compat.supportsToolChoice ?? detected.supportsToolChoice,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresMistralToolIds: model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		reasoningContentField: model.compat.reasoningContentField ?? detected.reasoningContentField,
		requiresReasoningContentForToolCalls:
			model.compat.requiresReasoningContentForToolCalls ?? detected.requiresReasoningContentForToolCalls,
		requiresAssistantContentForToolCalls:
			model.compat.requiresAssistantContentForToolCalls ?? detected.requiresAssistantContentForToolCalls,
		openRouterRouting: model.compat.openRouterRouting ?? detected.openRouterRouting,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		extraBody: model.compat.extraBody,
		toolStrictMode: model.compat.toolStrictMode ?? detected.toolStrictMode,
	};
}
