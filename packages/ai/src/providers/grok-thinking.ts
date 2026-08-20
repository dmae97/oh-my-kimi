import type { Api, Model, ThinkingLevelMap } from "../types.ts";

const GROK_THINKING_LEVELS = {
	"grok-4.6": {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "xhigh",
		ultra: "xhigh",
	},
	"grok-4.5": {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: "high",
		ultra: "high",
	},
	"grok-4.3": {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: "high",
		ultra: "high",
	},
} as const satisfies Record<string, ThinkingLevelMap>;

export function grokThinkingLevelMap(modelId: string): ThinkingLevelMap | undefined {
	return GROK_THINKING_LEVELS[modelId as keyof typeof GROK_THINKING_LEVELS];
}

function isOpenAICompletions(model: Model<Api>): model is Model<"openai-completions"> {
	return model.api === "openai-completions";
}

export function applyGrokThinking(model: Model<Api>): Model<Api> {
	if (!isOpenAICompletions(model)) {
		return model;
	}
	const thinkingLevelMap = grokThinkingLevelMap(model.id);
	if (!thinkingLevelMap) {
		return model;
	}
	const next: Model<"openai-completions"> = {
		...model,
		thinkingLevelMap,
		compat: {
			...model.compat,
			supportsReasoningEffort: true,
		},
	};
	return next;
}
