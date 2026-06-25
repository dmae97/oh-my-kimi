import {
	CONTEXT_BUDGET_POLICY_VERSION,
	type ContextBudgetItem,
	type ContextBudgetPlan,
	planContextBudget,
} from "./context-budget-governor.ts";
import { scoreContextFileRelevance, scoreSkillRelevance } from "./context-budget-relevance.ts";
import {
	type ContextBudgetTokenizerMode,
	createTokenCounterForMode,
	type TokenCounterAdapter,
} from "./context-budget-token-counter.ts";
import type { ContextFile } from "./resource-loader.ts";
import type { Skill } from "./skills.ts";

export interface SystemPromptContextBudgetOptions {
	readonly maxPromptTokens: number;
	readonly responseReserveTokens?: number;
	readonly modelId?: string;
	readonly tokenizerMode?: ContextBudgetTokenizerMode;
	readonly activeSkillNames?: readonly string[];
	readonly includeSkillInventory?: boolean;
	readonly includeFullContextFiles?: boolean;
	readonly tokenCounter?: TokenCounterAdapter;
	/** Maximum number of inactive (non-active) skills to include as items. Default: 15. */
	readonly maxInactiveSkills?: number;
	/** Current user query text for relevance-aware skill ranking. */
	readonly queryContext?: string;
}

export interface SystemPromptBudgetedResourcesInput {
	readonly basePrompt: string;
	readonly contextFiles: readonly ContextFile[];
	readonly skills: readonly Skill[];
	readonly includeSkills: boolean;
	readonly options: SystemPromptContextBudgetOptions;
}

export interface SystemPromptBudgetedResources {
	readonly text: string;
	readonly plan: ContextBudgetPlan;
}

const CONTEXT_EXCERPT_CHARS = 1200;
const MIN_EXCERPT_CHARS = 400;
const MAX_EXCERPT_CHARS = 3000;
const MAX_INACTIVE_SKILLS = 15;
const CONTEXT_FULL_BUDGET_RATIO = 0.5;

export function renderSystemPromptBudgetedResources(
	input: SystemPromptBudgetedResourcesInput,
): SystemPromptBudgetedResources {
	const tokenCounter =
		input.options.tokenCounter ?? createTokenCounterForMode(input.options.tokenizerMode ?? "fallback");
	const modelId = input.options.modelId ?? "unknown";
	const baseTokens = tokenCounter.countText(input.basePrompt, modelId).tokens;
	const resourceBudget = Math.max(0, input.options.maxPromptTokens - baseTokens);
	const items = createSystemPromptBudgetItems(input, resourceBudget);
	const plan = planContextBudget({
		maxTokens: resourceBudget,
		responseReserveTokens: input.options.responseReserveTokens ?? 0,
		modelId,
		policyVersion: CONTEXT_BUDGET_POLICY_VERSION,
		items,
		tokenCounter,
	});
	const included = new Set(plan.includedItems.map((item) => item.id));
	const filtered = deduplicatePointerFull(items, included);
	const text = filtered
		.filter((item) => included.has(item.id))
		.map((item) => item.text)
		.join("\n")
		.trimEnd();
	const note = renderBudgetNote(plan, baseTokens);
	return { text: text ? `${text}\n${note}` : note, plan };
}

function computeExcerptChars(resourceBudget: number, contextFullCount: number): number {
	if (contextFullCount <= 0) {
		return CONTEXT_EXCERPT_CHARS;
	}
	const allocatedTokens = Math.floor(resourceBudget * CONTEXT_FULL_BUDGET_RATIO) / contextFullCount;
	const estimatedChars = Math.floor(allocatedTokens * 4);
	return Math.max(MIN_EXCERPT_CHARS, Math.min(MAX_EXCERPT_CHARS, estimatedChars));
}

function createSystemPromptBudgetItems(
	input: SystemPromptBudgetedResourcesInput,
	resourceBudget: number,
): ContextBudgetItem[] {
	const items: ContextBudgetItem[] = [];
	const contextFullCount = input.options.includeFullContextFiles !== false ? input.contextFiles.length : 0;
	const excerptChars = computeExcerptChars(resourceBudget, contextFullCount);

	for (const contextFile of input.contextFiles) {
		const scope = contextFile.isGlobal ? "parent" : "project";
		const tagName = contextFile.isGlobal ? "parent_instructions" : "project_instructions";
		const queryScore = scoreContextFileRelevance(
			{ path: contextFile.path, content: contextFile.content, isGlobal: contextFile.isGlobal ?? false },
			input.options.queryContext,
		);
		const basePointer = contextFile.isGlobal ? 1 : 0.8;
		const baseFull = contextFile.isGlobal ? 0.9 : 0.6;
		items.push({
			id: `context-pointer:${contextFile.path}`,
			kind: "context-pointer",
			priority: contextFile.isGlobal ? "hard" : "high",
			relevance: basePointer * 0.4 + queryScore * 0.6,
			text: renderContextPointer(contextFile, scope),
		});
		if (input.options.includeFullContextFiles !== false) {
			items.push({
				id: `context-full:${contextFile.path}`,
				kind: "context-full",
				priority: contextFile.isGlobal ? "high" : "medium",
				relevance: baseFull * 0.4 + queryScore * 0.6,
				redundancyKey: contextFile.path,
				text: renderContextFull(contextFile, tagName, excerptChars),
			});
		}
	}

	const visibleSkills = input.skills.filter((skill) => !skill.disableModelInvocation);
	if (input.includeSkills && input.options.includeSkillInventory !== false && visibleSkills.length > 0) {
		items.push({ id: "skill-header", kind: "skill-header", priority: "hard", text: renderSkillHeader() });
		const activeSkillNames = new Set(input.options.activeSkillNames ?? []);
		const maxInactive = input.options.maxInactiveSkills ?? MAX_INACTIVE_SKILLS;

		// R2a: Active skills — always included at hard priority
		const activeSkills = visibleSkills.filter((skill) => activeSkillNames.has(skill.name));
		for (const skill of activeSkills) {
			items.push({
				id: `skill:${skill.name}`,
				kind: "skill",
				priority: "hard",
				relevance: 1,
				redundancyKey: skill.name,
				text: renderSkillEntry(skill),
			});
		}

		// R2b: Inactive skills — top N by query-aware relevance, rest summarized
		const inactiveSkills = visibleSkills.filter((skill) => !activeSkillNames.has(skill.name));
		const queryContext = input.options.queryContext;
		const sortedInactive = [...inactiveSkills].sort(
			(a, b) => scoreSkillRelevance(b, queryContext) - scoreSkillRelevance(a, queryContext),
		);
		const includedInactive = sortedInactive.slice(0, maxInactive);
		const omittedInactiveCount = sortedInactive.length - includedInactive.length;

		for (const skill of includedInactive) {
			const relevance = Math.max(0.25, scoreSkillRelevance(skill, queryContext));
			items.push({
				id: `skill:${skill.name}`,
				kind: "skill",
				priority: "low",
				relevance,
				redundancyKey: skill.name,
				text: renderSkillEntry(skill),
			});
		}

		items.push({ id: "skill-footer", kind: "skill-header", priority: "hard", text: "</available_skills>" });

		// R2c: Summary footer for omitted inactive skills
		if (omittedInactiveCount > 0) {
			items.push({
				id: "skill-omitted-summary",
				kind: "skill-header",
				priority: "low",
				relevance: 0.1,
				text: renderSkillOmittedSummary(omittedInactiveCount),
			});
		}
	}
	return items;
}

function renderContextPointer(contextFile: ContextFile, scope: string): string {
	const marker = contextFile.containsJailbreak ? " sanitized=true" : "";
	return `<context_file_pointer scope="${escapeXml(scope)}" path="${escapeXml(contextFile.path)}"${marker} chars="${contextFile.content.length}" />`;
}

function renderContextFull(contextFile: ContextFile, tagName: string, excerptChars = CONTEXT_EXCERPT_CHARS): string {
	const content =
		contextFile.content.length > excerptChars
			? boundedExcerpt(contextFile.content, excerptChars)
			: contextFile.content;
	const truncated = content.length < contextFile.content.length ? " truncated=true" : "";
	return `<${tagName} path="${escapeXml(contextFile.path)}"${truncated}>\n${content}\n</${tagName}>`;
}

function boundedExcerpt(content: string, excerptChars = CONTEXT_EXCERPT_CHARS): string {
	const headChars = Math.floor(excerptChars * 0.7);
	const tailChars = excerptChars - headChars;
	let head = content.slice(0, headChars);
	const lastSpace = head.search(/\s+\S*$/);
	if (lastSpace > headChars * 0.5) {
		head = head.slice(0, lastSpace);
	}
	let tail = content.slice(-tailChars);
	const firstSpace = tail.search(/\S+\s+/);
	if (firstSpace > 0 && firstSpace < tailChars * 0.5) {
		tail = tail.slice(firstSpace).trimStart();
	}
	return `${head}\n\n[...context-budget excerpt omitted ${content.length - excerptChars} chars...]\n\n${tail}`;
}

function renderSkillHeader(): string {
	return [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	].join("\n");
}

function renderSkillEntry(skill: Skill): string {
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

function renderSkillOmittedSummary(omittedCount: number): string {
	return `<!-- ${omittedCount} additional skills available. Use 'read' to load a specific skill file when a task matches. -->`;
}

function renderBudgetNote(plan: ContextBudgetPlan, baseTokens: number): string {
	const omitted = plan.omittedItems.length;
	return [
		"<context_budget>",
		`  <policy>${escapeXml(plan.policyVersion)}</policy>`,
		`  <plan_hash>${plan.planHash}</plan_hash>`,
		`  <base_prompt_tokens>${baseTokens}</base_prompt_tokens>`,
		`  <resource_tokens_used>${plan.usedTokens}</resource_tokens_used>`,
		`  <resource_tokens_omitted>${plan.omittedTokens}</resource_tokens_omitted>`,
		`  <omitted_items>${omitted}</omitted_items>`,
		`  <emergency>${plan.emergency ? "true" : "false"}</emergency>`,
		"  <note>Some low-priority resource inventory may be represented by pointers. Use read on referenced paths when needed.</note>",
		"</context_budget>",
	].join("\n");
}

/**
 * R3: When a context-full item is included, exclude the matching pointer
 * so the same file does not consume tokens twice.
 */
function deduplicatePointerFull(
	items: readonly ContextBudgetItem[],
	included: ReadonlySet<string>,
): readonly ContextBudgetItem[] {
	const includedFullPaths = new Set<string>();
	for (const item of items) {
		if (item.kind === "context-full" && included.has(item.id)) {
			const path = item.id.slice("context-full:".length);
			includedFullPaths.add(path);
		}
	}
	if (includedFullPaths.size === 0) {
		return items;
	}
	return items.filter((item) => {
		if (item.kind !== "context-pointer") {
			return true;
		}
		const path = item.id.slice("context-pointer:".length);
		return !includedFullPaths.has(path);
	});
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
