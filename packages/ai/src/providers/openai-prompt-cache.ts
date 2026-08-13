import type { Context } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { deriveContextPromptCacheKey } from "./prompt-cache.ts";
import { canonicalJsonStringify } from "./tool-schema.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export interface PromptCacheKeyInputs {
	workspacePath?: string;
	promptVersion: string;
	parentRulesVersion: string;
	toolSchemaVersion: string;
	sessionId?: string;
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export function derivePromptCacheKey(inputs: PromptCacheKeyInputs): string {
	const canonicalInputs = {
		parentRulesVersion: inputs.parentRulesVersion,
		promptVersion: inputs.promptVersion,
		sessionId: inputs.sessionId ?? "anonymous",
		toolSchemaVersion: inputs.toolSchemaVersion,
		workspacePath: inputs.workspacePath ?? "default",
	};
	return clampOpenAIPromptCacheKey(`omk-${shortHash(canonicalJsonStringify(canonicalInputs))}`) ?? "omk";
}

/**
 * Prefer a content-derived key when OMK supplied a stable cache boundary.
 * Keep session ids as the compatibility fallback for direct library callers.
 */
export function resolveOpenAIPromptCacheKey(
	context: Context,
	sessionId: string | undefined,
	scope: string,
): string | undefined {
	const contentKey = deriveContextPromptCacheKey(context, scope);
	if (contentKey) return clampOpenAIPromptCacheKey(contentKey);
	if (context.systemPromptCacheBoundaryBypass || context.systemPromptCacheBoundary !== undefined) return undefined;
	return clampOpenAIPromptCacheKey(sessionId);
}
