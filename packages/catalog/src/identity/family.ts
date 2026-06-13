/**
 * Model-family id predicates: the shared vocabulary for "is this id a member
 * of family X" checks that gate wire-level behavior across hosts (a Kimi or
 * DeepSeek model keeps its quirks no matter which OpenAI-compatible proxy
 * serves it). Looser per-feature heuristics (e.g. stream-markup healing)
 * deliberately keep their own patterns — only provably-shared matchers live
 * here.
 */

import { bareModelId, isFableOrMythos, parseAnthropicModel, parseGlmModel, semverGte } from "./classify";

/** Kimi family ids in any namespace form (`moonshotai/kimi-*`, `kimi-k2.6`, `vendor/kimi.x`). */
export function isKimiModelId(modelId: string): boolean {
	return modelId.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(modelId);
}

/** Kimi K2.6 specifically, including router ids that spell the version `k2p6`. */
export function isKimiK26ModelId(modelId: string): boolean {
	return /(^|\/)kimi-k2(?:\.6|p6)(?:[-:]|$)/i.test(modelId);
}

/** Claude ids in any namespace form (`claude-*`, `vendor/claude.x`). */
export function isClaudeModelId(modelId: string): boolean {
	return /(^|\/)claude[-.]/i.test(modelId);
}

/** `anthropic/`-namespaced ids (aggregator catalogs like OpenRouter). */
export function isAnthropicNamespacedModelId(modelId: string): boolean {
	return /(^|\/)anthropic\//i.test(modelId);
}

/** Qwen family ids (substring match — Qwen SKUs have no stable prefix shape). */
export function isQwenModelId(modelId: string): boolean {
	return modelId.toLowerCase().includes("qwen");
}

/** DeepSeek family by id or display name (proxies often rename the id but keep the name). */
export function isDeepseekModelIdOrName(value: string): boolean {
	return value.toLowerCase().includes("deepseek");
}

/** Xiaomi MiMo family by id or display name. */
export function isMimoModelIdOrName(value: string): boolean {
	return value.toLowerCase().includes("mimo");
}

/**
 * MiniMax M2-generation family (M2, M2.1, M2.5, M2.7, including `-highspeed`/
 * `-lightning`/`-her`/`-turbo` variants, dotless aliases like `minimax-m21`,
 * and short `minimax/m2-…` ids on aggregator hosts). Underlying model accepts
 * only `low|medium|high` for `reasoning_effort` and 400s on `minimal`,
 * `xhigh`, or `none` — so hosts whose default effort map otherwise lowers
 * `minimal` to `none` (Fireworks) or expects the full 5-tier scale must
 * clamp instead. Excludes M1, M3, MiniMax-Text-01, music, hailuo, voice ids.
 */
export function isMinimaxM2FamilyModelId(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;
	// Boundary-delimited `m2` token followed by zero or more digits (dotless
	// variants like `m21`/`m25`/`m27`) and an optional dotted minor version.
	return /(?:^|[/.-])m2\d*(?:[.-]\d+)?(?:[-.:_]|$)/i.test(lower);
}

/**
 * OpenAI gpt-oss family (`gpt-oss-20b`, `gpt-oss-120b`, `gpt-oss:120b`,
 * `vendor/gpt-oss-…`). The Harmony reasoning format only accepts
 * `low|medium|high` for `reasoning_effort` and rejects `minimal`, `xhigh`,
 * and `none`.
 */
export function isOpenAIGptOssModelId(modelId: string): boolean {
	return /(^|\/)gpt-oss[-:]/i.test(modelId);
}

/**
 * Reasoning-capable GLM coding SKUs: glm-4.5 and up on the base / `-air` /
 * `-turbo` lines. Excludes the vision (`…v`) shape, the non-reasoning
 * `-flash`/`-flashx`/`-preview` variants, and pre-4.5 ids. Matching the family
 * keeps newly-bumped integers (`glm-5.3`, `glm-6`, …) covered without a per-id
 * allowlist.
 */
export function isReasoningGlmModelId(modelId: string): boolean {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "4.5");
}

/** GLM vision SKUs — the `v` that attaches to the version (`glm-4v`, `glm-4.5v`). */
export function isGlmVisionModelId(modelId: string): boolean {
	return parseGlmModel(bareModelId(modelId))?.vision === true;
}

/**
 * Adaptive thinking `display` is supported starting with Claude Opus 4.7 and
 * the Claude Fable/Mythos 5 generation. Older adaptive-thinking models
 * (Opus 4.6, Sonnet 4.6+) reject the field. Classifier-based, so dotted and
 * dashed version forms both match while bare dated ids
 * (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
 */
export function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	if (!parsed) return false;
	if (isFableOrMythos(parsed.kind)) return semverGte(parsed.version, "5");
	return parsed.kind === "opus" && semverGte(parsed.version, "4.7");
}

/**
 * Returns true for Anthropic models with Opus 4.7+/Fable/Mythos API restrictions:
 * - Sampling parameters (temperature/top_p/top_k) return 400 error
 * - Thinking content is omitted by default (needs display: "summarized")
 */
export function hasOpus47ApiRestrictions(modelId: string): boolean {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	if (!parsed) return false;
	return (parsed.kind === "opus" && semverGte(parsed.version, "4.7")) || isFableOrMythos(parsed.kind);
}

/**
 * Mid-conversation `role: "system"` messages (system instructions appended at
 * non-first positions in the `messages` array) are supported starting with
 * Claude Opus 4.8 and the Claude Fable/Mythos 5 generation. Earlier Claude
 * models reject the role.
 * @see https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
export function supportsMidConversationSystemMessages(modelId: string): boolean {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	if (!parsed) return false;
	return (parsed.kind === "opus" && semverGte(parsed.version, "4.8")) || isFableOrMythos(parsed.kind);
}

export function isAnthropicFableOrMythosModel(modelId: string): boolean {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isFableOrMythos(parsed.kind);
}

/** Thinking-variant token location inside a model id. */
export interface ThinkingVariantToken {
	index: number;
	length: number;
}

const THINKING_VARIANT_TOKEN_RE = /-(?:thinking|reasoner|reasoning)(?=$|[^a-z0-9])/gi;

/**
 * Locates the first thinking-variant token (`-thinking`, `-reasoner`,
 * `-reasoning`; trailing or infix) in a model id. The token ends at the id
 * end or any non-alphanumeric boundary, and negated forms (`non-thinking`,
 * `no-thinking`) never match — those name the NON-thinking SKU.
 */
export function findThinkingVariantToken(modelId: string): ThinkingVariantToken | undefined {
	THINKING_VARIANT_TOKEN_RE.lastIndex = 0;
	let match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	while (match !== null) {
		const preceding = /([a-z0-9]+)$/i.exec(modelId.slice(0, match.index))?.[1]?.toLowerCase();
		if (preceding !== "non" && preceding !== "no") {
			return { index: match.index, length: match[0].length };
		}
		match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	}
	return undefined;
}

/**
 * Removes the located thinking-variant token: `kimi-k2-thinking` → `kimi-k2`,
 * `mimo-v2-flash-thinking-original` → `mimo-v2-flash-original`,
 * `grok-4.1-fast-reasoning` → `grok-4.1-fast`. Returns `undefined` when no
 * token exists or nothing would remain. Callers MUST verify the result names
 * a live model.
 */
export function stripThinkingVariantToken(modelId: string): string | undefined {
	const token = findThinkingVariantToken(modelId);
	if (!token) return undefined;
	const stripped = modelId.slice(0, token.index) + modelId.slice(token.index + token.length);
	return stripped.length > 0 ? stripped : undefined;
}
