export type PromptCacheTransitionKind = "bypass" | "first" | "same" | "changed";

export interface PromptCacheTransition {
	readonly kind: PromptCacheTransitionKind;
	/** Whether the session should record the break reason for this transition. */
	readonly recordBreak: boolean;
}

/**
 * Classify a prompt-cache key transition. A missing next key bypasses the
 * cache; a first key establishes it; an identical key is stable; a different
 * key is a change. Break reasons are recorded for bypasses that drop an
 * established key and for outright changes — never for establishment.
 */
export function classifyPromptCacheTransition(
	currentKey: string | undefined,
	nextKey: string | undefined,
): PromptCacheTransition {
	if (nextKey === undefined) return { kind: "bypass", recordBreak: currentKey !== undefined };
	if (currentKey === undefined) return { kind: "first", recordBreak: false };
	if (currentKey === nextKey) return { kind: "same", recordBreak: false };
	return { kind: "changed", recordBreak: true };
}
