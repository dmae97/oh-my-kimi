const RESPONSE_RESERVE_RATIO = 0.2;
const SAFETY_MARGIN_RATIO = 0.1;
const MIN_PROMPT_TOKENS = 4000;
const LEGACY_MAX_PROMPT_TOKENS = 60_000;
const LEGACY_RESPONSE_RESERVE_TOKENS = 8_192;

export interface PromptTokenBudgetInput {
	readonly contextWindow: number;
	readonly modelMaxTokens?: number;
	readonly envMaxPromptTokens?: number;
	readonly envResponseReserveTokens?: number;
	readonly envPromptRatio?: number;
	readonly envResponseRatio?: number;
}

export interface PromptTokenBudget {
	readonly maxPromptTokens: number;
	readonly responseReserveTokens: number;
}

/** Response reserve prefers the model's own maxTokens, else a window ratio with the legacy floor. */
export function computeResponseReserveTokens(
	contextWindow: number,
	modelMaxTokens?: number,
	overrideRatio?: number,
): number {
	if (modelMaxTokens !== undefined && modelMaxTokens > 0 && modelMaxTokens < contextWindow) {
		return modelMaxTokens;
	}
	const ratio = overrideRatio ?? RESPONSE_RESERVE_RATIO;
	return Math.max(Math.floor(contextWindow * ratio), LEGACY_RESPONSE_RESERVE_TOKENS);
}

/**
 * Prompt budget: explicit env max wins; otherwise window minus reserve and
 * safety margin (or an env prompt ratio); no window falls back to legacy
 * defaults. The prompt floor and reserve cap keep the pair usable.
 */
export function computePromptTokenBudget(input: PromptTokenBudgetInput): PromptTokenBudget {
	let maxPromptTokens: number;
	let responseReserveTokens: number;

	if (input.envMaxPromptTokens !== undefined) {
		maxPromptTokens = input.envMaxPromptTokens;
		responseReserveTokens =
			input.envResponseReserveTokens ?? computeResponseReserveTokens(input.contextWindow, input.modelMaxTokens);
	} else if (input.contextWindow > 0) {
		responseReserveTokens =
			input.envResponseReserveTokens ??
			computeResponseReserveTokens(input.contextWindow, input.modelMaxTokens, input.envResponseRatio);
		const safetyMargin = Math.floor(input.contextWindow * SAFETY_MARGIN_RATIO);
		if (input.envPromptRatio !== undefined && input.envPromptRatio > 0 && input.envPromptRatio < 1) {
			maxPromptTokens = Math.floor(input.contextWindow * input.envPromptRatio);
		} else {
			maxPromptTokens = input.contextWindow - responseReserveTokens - safetyMargin;
		}
	} else {
		maxPromptTokens = LEGACY_MAX_PROMPT_TOKENS;
		responseReserveTokens = input.envResponseReserveTokens ?? LEGACY_RESPONSE_RESERVE_TOKENS;
	}

	if (maxPromptTokens < MIN_PROMPT_TOKENS) {
		maxPromptTokens = MIN_PROMPT_TOKENS;
	}
	if (responseReserveTokens >= maxPromptTokens) {
		responseReserveTokens = Math.max(Math.floor(maxPromptTokens / 4), LEGACY_RESPONSE_RESERVE_TOKENS);
	}
	return { maxPromptTokens, responseReserveTokens };
}
