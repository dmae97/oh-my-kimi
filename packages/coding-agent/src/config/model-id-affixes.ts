const LEADING_BRACKETED_AFFIX_PATTERN = /^(?:\s*(?:\[|【)[^\]】]+(?:\]|】)\s*)+/u;
const TRAILING_BRACKETED_AFFIX_PATTERN = /(?:\s*(?:\[|【)[^\]】]+(?:\]|】)\s*)+$/u;
const MODEL_ID_SEGMENT_PATTERN = /[a-z0-9.:-]+/g;
const MODEL_FAMILY_PREFIX_PATTERN =
	/^(claude|gemini|gpt|grok|glm|qwen|deepseek|kimi|mimo|doubao|ernie|gpt-oss|gemma|minimax|step|command|jamba|llama|o[1345])/i;

function hasDigit(value: string): boolean {
	return /\d/.test(value);
}

function compareSegmentPreference(left: string, right: string): number {
	if (left.length !== right.length) {
		return right.length - left.length;
	}
	return left.localeCompare(right);
}

export function getModelLikeIdSegments(modelId: string): string[] {
	const normalized = normalizeModelIdWhitespace(modelId).toLowerCase();
	if (!normalized) return [];
	const segments = (normalized.match(MODEL_ID_SEGMENT_PATTERN) ?? []).filter(
		segment => MODEL_FAMILY_PREFIX_PATTERN.test(segment) && hasDigit(segment),
	);
	const unique = [...new Set(segments)];
	unique.sort(compareSegmentPreference);
	return unique;
}

export function getLongestModelLikeIdSegment(modelId: string): string | undefined {
	return getModelLikeIdSegments(modelId)[0];
}

function normalizeModelIdWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

/**
 * Strip reseller / wrapper tags that are injected as bracketed affixes around an
 * upstream model id, e.g.
 *   "[Kiro] claude-opus-4-8"                -> "claude-opus-4-8"
 *   "[gcli转] gemini-3.1-pro-preview [假流]" -> "gemini-3.1-pro-preview"
 */
export function getBracketStrippedModelIdCandidates(modelId: string): string[] {
	const normalized = normalizeModelIdWhitespace(modelId);
	if (!normalized) return [];

	const candidates = new Set<string>();
	const withoutLeading = normalizeModelIdWhitespace(normalized.replace(LEADING_BRACKETED_AFFIX_PATTERN, ""));
	const withoutTrailing = normalizeModelIdWhitespace(normalized.replace(TRAILING_BRACKETED_AFFIX_PATTERN, ""));
	const withoutBoth = normalizeModelIdWhitespace(
		normalized.replace(LEADING_BRACKETED_AFFIX_PATTERN, "").replace(TRAILING_BRACKETED_AFFIX_PATTERN, ""),
	);

	for (const candidate of [withoutBoth, withoutLeading, withoutTrailing]) {
		if (candidate && candidate !== normalized) {
			candidates.add(candidate);
		}
	}
	return [...candidates];
}

export function stripBracketedModelIdAffixes(modelId: string): string | undefined {
	return getBracketStrippedModelIdCandidates(modelId)[0];
}
