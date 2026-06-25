import { shortHash } from "../utils/hash.ts";
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
