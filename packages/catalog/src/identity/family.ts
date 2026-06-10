/**
 * Model-family id predicates: the shared vocabulary for "is this id a member
 * of family X" checks that gate wire-level behavior across hosts (a Kimi or
 * DeepSeek model keeps its quirks no matter which OpenAI-compatible proxy
 * serves it). Looser per-feature heuristics (e.g. stream-markup healing)
 * deliberately keep their own patterns — only provably-shared matchers live
 * here.
 */

import { bareModelId, isFableOrMythos, parseAnthropicModel, semverGte } from "./classify";

/** Kimi family ids in any namespace form (`moonshotai/kimi-*`, `kimi-k2.6`, `vendor/kimi.x`). */
export function isKimiModelId(modelId: string): boolean {
	return modelId.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(modelId);
}

/** Kimi K2.6 specifically (preserved-thinking transport on Moonshot-native hosts). */
export function isKimiK26ModelId(modelId: string): boolean {
	return /(^|\/)kimi-k2\.6(?:[-:]|$)/i.test(modelId);
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
