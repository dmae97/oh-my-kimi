export const PROMPT_PRESET_IDS = ["kimi", "kimi-k3", "glm", "grok", "claude"] as const;

export type PromptPresetId = (typeof PROMPT_PRESET_IDS)[number];

export interface PromptPreset {
	readonly id: PromptPresetId;
	readonly guidelines: readonly string[];
}

const PRESETS: Record<PromptPresetId, PromptPreset> = {
	kimi: {
		id: "kimi",
		guidelines: [
			"Prefer short tool batches. One write path per batch.",
			"Keep file reads scoped with offset/limit instead of dumping whole files.",
		],
	},
	"kimi-k3": {
		id: "kimi-k3",
		guidelines: [
			"Never emit a tool_result without a matching tool_use id from this turn.",
			"If a previous turn dropped, sanitize orphans before retrying the same tool.",
		],
	},
	glm: {
		id: "glm",
		guidelines: [
			"State the next concrete file or command before calling a tool.",
			"Do not restate the plan after every tool result.",
		],
	},
	grok: {
		id: "grok",
		guidelines: [
			"Deliver the artifact first. Do not narrate the rest as similar.",
			"Keep user-facing prose Korean; leave code and API ids verbatim.",
		],
	},
	claude: {
		id: "claude",
		guidelines: [
			"Treat the request as a software-engineering task: inspect the repository, perform the requested action, and verify the result.",
			"When a request contains mixed topics, complete the concrete in-scope task and ask only for a missing required decision.",
			"Use tools for repository facts; base conclusions on observed files and command output.",
		],
	},
};

const MATCHERS: ReadonlyArray<{ readonly id: PromptPresetId; readonly pattern: RegExp }> = [
	{ id: "kimi-k3", pattern: /kimi[-_.]?k3/i },
	{ id: "kimi", pattern: /kimi/i },
	{ id: "glm", pattern: /glm|zai|zhipu/i },
	{ id: "grok", pattern: /grok|xai/i },
	{ id: "claude", pattern: /(^|[/_.:-])(claude|anthropic)([/_.:-]|$)/i },
];

export function resolvePromptPreset(modelId: string | undefined): PromptPreset | undefined {
	if (!modelId) return undefined;
	for (const matcher of MATCHERS) {
		if (matcher.pattern.test(modelId)) return PRESETS[matcher.id];
	}
	return undefined;
}
