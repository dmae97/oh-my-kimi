/**
 * Generation-time catalog policies: upstream metadata corrections, derived
 * field baking, and promotion-target linking. Runs only from
 * `generate-models.ts` — none of this ships in the runtime bundle.
 */
import { buildCompat } from "../src/build";
import {
	type AnthropicModel,
	isFableOrMythos,
	type OpenAIModel,
	type OpenAIVariant,
	type ParsedModel,
	parseKnownModel,
	semverEqual,
} from "../src/identity/classify";
import { resolveModelThinking } from "../src/model-thinking";
import type { Api, ModelSpec } from "../src/types";
import { isVariantCollapsedSpec } from "../src/variant-collapse";

const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic";

/**
 * Static fallback model injected when Cloudflare AI Gateway discovery
 * returns no results. Ensures the provider always has at least one usable
 * model entry in the catalog.
 */
export const CLOUDFLARE_FALLBACK_MODEL: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	contextWindow: 200000,
	maxTokens: 64000,
};

const CODEX_GPT_5_4_PRIORITY_BY_VARIANT: Partial<Record<OpenAIVariant, number>> = {
	base: 0,
	mini: 1,
	nano: 2,
};

const COPILOT_GENERATED_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
	"claude-opus-4.6": { contextWindow: 168000, maxTokens: 32000 },
	"gpt-5.2": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4-mini": { contextWindow: 272000, maxTokens: 128000 },
	"grok-code-fast-1": { contextWindow: 192000, maxTokens: 64000 },
};

/**
 * Apply upstream metadata corrections to a mutable array of models, then
 * re-bake canonical thinking metadata so generated catalogs always carry the
 * deriver's output for the post-policy spec.
 */
export function applyGeneratedModelPolicies(models: ModelSpec<Api>[]): void {
	for (const model of models) {
		applyGeneratedModelPolicy(model);
		rebakeModelThinking(model);
	}
}

/**
 * Recompute `thinking` from the canonical deriver, replacing any baked value.
 * Mirrors `buildModel`'s trust-or-derive resolution with trust disabled: the
 * generator is the authority that produces the trusted values. Collapsed
 * effort-tier variants are exempt — their collapse table authored the
 * routing/off-suppression metadata and the deriver cannot reproduce it.
 */
export function rebakeModelThinking(model: ModelSpec<Api>): void {
	if (isVariantCollapsedSpec(model)) return;
	const thinking = resolveModelThinking({ ...model, thinking: undefined }, buildCompat(model));
	if (thinking) {
		model.thinking = thinking;
	} else {
		delete model.thinking;
	}
}

/**
 * Link OpenAI model variants to their context promotion targets.
 *
 * When a model's context is exhausted, the agent can promote to a sibling
 * model with a larger context window on the same provider:
 * - `codex-spark` variants promote to `gpt-5.5`.
 * - `gpt-5.5` (270K input) promotes to `gpt-5.4` (1M input).
 */
export function linkOpenAIPromotionTargets(models: ModelSpec<Api>[]): void {
	for (const candidate of models) {
		const parsedCandidate = parseKnownModel(candidate.id);
		if (parsedCandidate.family !== "openai") continue;
		let targetId: string | undefined;
		if (parsedCandidate.variant === "codex-spark") {
			targetId = "gpt-5.5";
		} else if (parsedCandidate.variant === "base" && semverEqual(parsedCandidate.version, "5.5")) {
			targetId = "gpt-5.4";
		} else {
			continue;
		}
		const fallback = models.find(
			model => model.provider === candidate.provider && model.api === candidate.api && model.id === targetId,
		);
		if (!fallback) continue;
		candidate.contextPromotionTarget = `${fallback.provider}/${fallback.id}`;
	}
}

function applyGeneratedModelPolicy(model: ModelSpec<Api>): void {
	const copilotLimits = model.provider === "github-copilot" ? COPILOT_GENERATED_LIMITS[model.id] : undefined;
	if (copilotLimits) {
		model.contextWindow = copilotLimits.contextWindow;
		model.maxTokens = copilotLimits.maxTokens;
	}

	if (
		model.api === "openai-completions" &&
		(model.provider === "minimax-code" || model.provider === "minimax-code-cn")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		};
		delete model.compat.thinkingFormat;
	}
	if (
		model.api === "openai-completions" &&
		model.provider === "opencode-go" &&
		(model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
		};
	}
	const parsedModel = parseKnownModel(model.id);
	const applyPatchToolType = inferGeneratedApplyPatchToolType(model, parsedModel);
	if (applyPatchToolType) {
		model.applyPatchToolType = applyPatchToolType;
	} else {
		delete model.applyPatchToolType;
	}
	if (parsedModel.family === "anthropic") {
		applyAnthropicCatalogPolicy(model, parsedModel);
	}
	if (parsedModel.family === "openai") {
		applyOpenAICatalogPolicy(model, parsedModel);
	}
}

function applyAnthropicCatalogPolicy(model: ModelSpec<Api>, parsedModel: AnthropicModel): void {
	// Claude Opus 4.5: models.dev reports 3x the correct cache pricing.
	if (model.provider === "anthropic" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.5")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
	}

	// Bedrock Opus 4.6: upstream metadata is stale for cache pricing and context.
	if (model.provider === "amazon-bedrock" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.6")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
		model.contextWindow = 1000000;
		model.maxTokens = 128000;
	}

	// Claude Fable/Mythos 5: Anthropic's /v1/models omits token limits and
	// pricing, and models.dev lags new releases. Pin authoritative values from
	// the model card (1M context / 128k output) and pricing docs ($10 in / $50
	// out per MTok).
	if (model.provider === "anthropic" && isFableOrMythos(parsedModel.kind)) {
		model.contextWindow = 1_000_000;
		model.maxTokens = 128_000;
		model.cost.input = 10;
		model.cost.output = 50;
		model.cost.cacheRead = 1;
		model.cost.cacheWrite = 12.5;
	}
}

function inferGeneratedApplyPatchToolType(
	model: ModelSpec<Api>,
	parsedModel: ParsedModel,
): ModelSpec<Api>["applyPatchToolType"] {
	if (parsedModel.family !== "openai" || parsedModel.version.major !== 5) {
		return undefined;
	}
	if (model.provider === "openai" && model.api === "openai-responses") {
		return "freeform";
	}
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return "freeform";
	}
	return undefined;
}

function applyOpenAICatalogPolicy(model: ModelSpec<Api>, parsedModel: OpenAIModel): void {
	// Codex models: 400K figure includes output budget; input window is 272K.
	if (parsedModel.variant.startsWith("codex") && parsedModel.variant !== "codex-spark") {
		model.contextWindow = 272000;
		return;
	}
	// GPT-5.4 mini/nano use plain OpenAI IDs on the Codex transport, but Codex still
	// enforces the lower prompt budget for these variants. Codex discovery can also
	// report inconsistent priorities for the GPT-5.4 family, so normalize by parsed
	// variant instead of special-casing raw model ids.
	if (model.api === "openai-codex-responses" && semverEqual(parsedModel.version, "5.4")) {
		const normalizedPriority = CODEX_GPT_5_4_PRIORITY_BY_VARIANT[parsedModel.variant];
		if (normalizedPriority !== undefined) {
			model.priority = normalizedPriority;
		}
		if (parsedModel.variant === "mini" || parsedModel.variant === "nano") {
			model.contextWindow = 272000;
		}
	}
}
