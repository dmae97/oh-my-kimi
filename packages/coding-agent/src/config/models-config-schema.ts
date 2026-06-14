import { z } from "zod/v4";

const OpenRouterRoutingSchema = z.object({
	only: z.array(z.string()).optional(),
	order: z.array(z.string()).optional(),
});

const VercelGatewayRoutingSchema = z.object({
	only: z.array(z.string()).optional(),
	order: z.array(z.string()).optional(),
});

const ReasoningEffortMapSchema = z.object({
	minimal: z.string().optional(),
	low: z.string().optional(),
	medium: z.string().optional(),
	high: z.string().optional(),
	xhigh: z.string().optional(),
});

const OpenAICompatFieldsSchema = z.object({
	supportsStore: z.boolean().optional(),
	supportsDeveloperRole: z.boolean().optional(),
	supportsMultipleSystemMessages: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	reasoningEffortMap: ReasoningEffortMapSchema.optional(),
	maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
	supportsUsageInStreaming: z.boolean().optional(),
	requiresToolResultName: z.boolean().optional(),
	requiresMistralToolIds: z.boolean().optional(),
	requiresAssistantAfterToolResult: z.boolean().optional(),
	requiresThinkingAsText: z.boolean().optional(),
	reasoningContentField: z.enum(["reasoning_content", "reasoning", "reasoning_text"]).optional(),
	requiresReasoningContentForToolCalls: z.boolean().optional(),
	allowsSyntheticReasoningContentForToolCalls: z.boolean().optional(),
	requiresAssistantContentForToolCalls: z.boolean().optional(),
	supportsToolChoice: z.boolean().optional(),
	supportsForcedToolChoice: z.boolean().optional(),
	disableReasoningOnForcedToolChoice: z.boolean().optional(),
	disableReasoningOnToolChoice: z.boolean().optional(),
	thinkingFormat: z.enum(["openai", "openrouter", "zai", "qwen", "qwen-chat-template"]).optional(),
	openRouterRouting: OpenRouterRoutingSchema.optional(),
	vercelGatewayRouting: VercelGatewayRoutingSchema.optional(),
	extraBody: z.record(z.string(), z.unknown()).optional(),
	cacheControlFormat: z.enum(["anthropic"]).optional(),
	supportsStrictMode: z.boolean().optional(),
	toolStrictMode: z.enum(["all_strict", "none"]).optional(),
	streamIdleTimeoutMs: z.number().nonnegative().optional(),
	supportsLongPromptCacheRetention: z.boolean().optional(),
	supportsReasoningParams: z.boolean().optional(),
	alwaysSendMaxTokens: z.boolean().optional(),
	strictResponsesPairing: z.boolean().optional(),
	// anthropic-messages compat flags (same `compat` slot, per-api interpretation)
	requiresToolResultId: z.boolean().optional(),
	replayUnsignedThinking: z.boolean().optional(),
});

export const OpenAICompatSchema = OpenAICompatFieldsSchema.extend({
	whenThinking: OpenAICompatFieldsSchema.optional(),
});

const EffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const ThinkingControlModeSchema = z.enum([
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
]);

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Accepts the canonical `efforts` vocabulary plus the legacy
 * `minLevel`/`maxLevel`/`levels` range shape, normalizing both to
 * `ThinkingConfig` (ordered `efforts`, never empty). Precedence mirrors the
 * old runtime: explicit `levels` beat the min..max range; `efforts` beats both.
 */
const ModelThinkingSchema = z
	.object({
		mode: ThinkingControlModeSchema,
		efforts: z.array(EffortSchema).min(1).optional(),
		defaultLevel: EffortSchema.optional(),
		effortMap: ReasoningEffortMapSchema.optional(),
		supportsDisplay: z.boolean().optional(),
		// Legacy range vocabulary (pre-efforts configs).
		minLevel: EffortSchema.optional(),
		maxLevel: EffortSchema.optional(),
		levels: z.array(EffortSchema).min(1).optional(),
	})
	.refine(
		value =>
			value.efforts !== undefined ||
			value.levels !== undefined ||
			(value.minLevel !== undefined && value.maxLevel !== undefined),
		{
			message: "thinking requires `efforts` (or legacy `levels`/`minLevel`+`maxLevel`)",
		},
	)
	.transform(({ efforts, levels, minLevel, maxLevel, mode, defaultLevel, effortMap, supportsDisplay }) => {
		let resolved = efforts ?? levels;
		if (!resolved) {
			const minIndex = EFFORT_ORDER.indexOf(minLevel!);
			const maxIndex = EFFORT_ORDER.indexOf(maxLevel!);
			resolved = EFFORT_ORDER.slice(minIndex, Math.max(minIndex, maxIndex) + 1);
		}
		return {
			mode,
			efforts: resolved,
			...(defaultLevel !== undefined && { defaultLevel }),
			...(effortMap !== undefined && { effortMap }),
			...(supportsDisplay !== undefined && { supportsDisplay }),
		};
	});

const ModelDefinitionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1).optional(),
	api: z
		.enum([
			"openai-completions",
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"anthropic-messages",
			"google-generative-ai",
			"google-gemini-cli",
			"google-vertex",
		])
		.optional(),
	baseUrl: z.string().min(1).optional(),
	reasoning: z.boolean().optional(),
	thinking: ModelThinkingSchema.optional(),
	input: z.array(z.enum(["text", "image"])).optional(),
	cost: z
		.object({
			input: z.number(),
			output: z.number(),
			cacheRead: z.number(),
			cacheWrite: z.number(),
		})
		.optional(),
	premiumMultiplier: z.number().optional(),
	contextWindow: z.number().optional(),
	maxTokens: z.number().optional(),
	omitMaxOutputTokens: z.boolean().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	compat: OpenAICompatSchema.optional(),
	contextPromotionTarget: z.string().min(1).optional(),
});

export const ModelOverrideSchema = z.object({
	name: z.string().min(1).optional(),
	reasoning: z.boolean().optional(),
	thinking: ModelThinkingSchema.optional(),
	input: z.array(z.enum(["text", "image"])).optional(),
	cost: z
		.object({
			input: z.number().optional(),
			output: z.number().optional(),
			cacheRead: z.number().optional(),
			cacheWrite: z.number().optional(),
		})
		.optional(),
	premiumMultiplier: z.number().optional(),
	contextWindow: z.number().optional(),
	maxTokens: z.number().optional(),
	omitMaxOutputTokens: z.boolean().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	compat: OpenAICompatSchema.optional(),
	contextPromotionTarget: z.string().min(1).optional(),
});

export type ModelOverride = z.infer<typeof ModelOverrideSchema>;

export const ProviderDiscoverySchema = z.object({
	type: z.enum(["ollama", "llama.cpp", "lm-studio", "openai-models-list", "proxy"]),
});

export const ProviderAuthSchema = z.enum(["apiKey", "none", "oauth"]);

export type ProviderAuthMode = z.infer<typeof ProviderAuthSchema>;
export type ProviderDiscovery = z.infer<typeof ProviderDiscoverySchema>;

const ProviderConfigSchema = z.object({
	baseUrl: z.string().min(1).optional(),
	apiKey: z.string().min(1).optional(),
	api: z
		.enum([
			"openai-completions",
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"anthropic-messages",
			"google-generative-ai",
			"google-gemini-cli",
			"google-vertex",
		])
		.optional(),
	headers: z.record(z.string(), z.string()).optional(),
	compat: OpenAICompatSchema.optional(),
	authHeader: z.boolean().optional(),
	auth: ProviderAuthSchema.optional(),
	discovery: ProviderDiscoverySchema.optional(),
	models: z.array(ModelDefinitionSchema).optional(),
	modelOverrides: z.record(z.string(), ModelOverrideSchema).optional(),
	disableStrictTools: z.boolean().optional(),
	/**
	 * Streaming transport override. When set to `"pi-native"`, omp dispatches
	 * every model under this provider via the auth-gateway's
	 * `POST /v1/pi/stream` endpoint instead of the per-provider SDK. The
	 * provider's `baseUrl` must point at a compatible `omp auth-gateway`
	 * and `apiKey` must carry the gateway bearer.
	 */
	transport: z.literal("pi-native").optional(),
});

const EquivalenceConfigSchema = z.object({
	overrides: z.record(z.string(), z.string().min(1)).optional(),
	exclude: z.array(z.string().min(1)).optional(),
});

export const ModelsConfigSchema = z.object({
	providers: z.record(z.string(), ProviderConfigSchema).optional(),
	equivalence: EquivalenceConfigSchema.optional(),
});

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
