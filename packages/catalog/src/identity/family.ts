/**
 * Model-family id predicates: the shared vocabulary for "is this id a member
 * of family X" checks that gate wire-level behavior across hosts (a Kimi or
 * DeepSeek model keeps its quirks no matter which OpenAI-compatible proxy
 * serves it). Looser per-feature heuristics (e.g. stream-markup healing)
 * deliberately keep their own patterns — only provably-shared matchers live
 * here.
 */

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
 * Claude Fable/Mythos 5. Older adaptive-thinking models (Opus 4.6, Sonnet
 * 4.6+) reject the field.
 */
export function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	if (/claude-(?:fable|mythos)-5\b/.test(modelId)) return true;
	// Bound the minor to non-date digits: bare dated ids like
	// `claude-opus-4-20250514` (Opus 4.0) must not parse as minor=20250514.
	const match = /claude-opus-(\d+)-(\d{1,2})(?!\d)/.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 4 || (major === 4 && minor >= 7);
}
