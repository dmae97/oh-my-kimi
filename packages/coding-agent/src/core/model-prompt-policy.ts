import type { ContextFile } from "./context-file.ts";

export interface PromptModelReference {
	readonly provider: string;
	readonly id: string;
}

const ENABLED_ENV_VALUES = new Set(["1", "true", "on", "yes"]);

function isClaudeModel(model: PromptModelReference | undefined): boolean {
	if (!model) return false;
	return model.provider.toLowerCase() === "anthropic" || /(^|[/_.:-])claude([/_.:-]|$)/i.test(model.id);
}

/**
 * Claude-family models use the stable OMK prompt without discovered context files by default.
 * Some provider classifiers reject otherwise benign turns based only on unrelated AGENTS.md text.
 */
export function selectContextFilesForModel(
	contextFiles: readonly ContextFile[],
	model: PromptModelReference | undefined,
): readonly ContextFile[] {
	if (!isClaudeModel(model)) return contextFiles;

	const override = process.env.OMK_CLAUDE_CONTEXT_FILES?.trim().toLowerCase();
	return override && ENABLED_ENV_VALUES.has(override) ? contextFiles : [];
}
