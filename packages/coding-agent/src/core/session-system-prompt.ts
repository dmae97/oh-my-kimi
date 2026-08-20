import type { ContextFile } from "./resource-loader.ts";
import type { Skill } from "./skills.ts";
import { type BuildSystemPromptOptions, type BuiltSystemPrompt, buildSystemPromptPlan } from "./system-prompt.ts";

export interface SessionSystemPromptInput {
	readonly cwd: string;
	readonly toolNames: readonly string[];
	readonly hasTool: (name: string) => boolean;
	readonly toolPromptSnippets: ReadonlyMap<string, string>;
	readonly toolPromptGuidelines: ReadonlyMap<string, readonly string[]>;
	readonly customPrompt?: string;
	readonly appendSystemPrompt?: readonly string[];
	readonly providerAppend?: string;
	readonly skills: readonly Skill[];
	readonly contextFiles: readonly ContextFile[];
	readonly contextBudget?: BuildSystemPromptOptions["contextBudget"];
}

export interface SessionSystemPromptAssembly {
	readonly options: BuildSystemPromptOptions;
	readonly prompt: string;
	readonly cacheBoundary: number;
}

/**
 * Pure assembly of the session system-prompt plan: tool filtering, snippet and
 * guideline collection, and append-section joining. Callers resolve side effects
 * (resource loader reads, provider playbook files) and pass them in.
 */
export function assembleSessionSystemPrompt(input: SessionSystemPromptInput): SessionSystemPromptAssembly {
	const validToolNames = input.toolNames.filter((name) => input.hasTool(name));
	const toolSnippets: Record<string, string> = {};
	const promptGuidelines: string[] = [];
	for (const name of validToolNames) {
		const snippet = input.toolPromptSnippets.get(name);
		if (snippet) toolSnippets[name] = snippet;
		const toolGuidelines = input.toolPromptGuidelines.get(name);
		if (toolGuidelines) promptGuidelines.push(...toolGuidelines);
	}

	const appendParts = [...(input.appendSystemPrompt ?? [])];
	if (input.providerAppend) appendParts.push(input.providerAppend);
	const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

	const options: BuildSystemPromptOptions = {
		cwd: input.cwd,
		skills: [...input.skills],
		contextFiles: [...input.contextFiles],
		customPrompt: input.customPrompt,
		appendSystemPrompt,
		selectedTools: validToolNames,
		toolSnippets,
		promptGuidelines,
		contextBudget: input.contextBudget,
	};
	const built: BuiltSystemPrompt = buildSystemPromptPlan(options);
	return { options, prompt: built.prompt, cacheBoundary: built.cacheBoundary };
}
