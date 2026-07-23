import { pathToFileURL } from "node:url";
import { type ContextBudgetItemV2, fnv1aHex } from "./context-budget-governor-v2.ts";
import { scoreContextFileRelevance, scoreSkillRelevance } from "./context-budget-relevance.ts";
import type { ContextFile } from "./resource-loader.ts";
import type { Skill } from "./skills.ts";

interface SystemPromptBudgetItemInput {
	readonly contextFiles: readonly ContextFile[];
	readonly skills: readonly Skill[];
	readonly includeSkills: boolean;
	readonly options: {
		readonly activeSkillNames?: readonly string[];
		readonly includeSkillInventory?: boolean;
		readonly includeFullContextFiles?: boolean;
		readonly maxInactiveSkills?: number;
		readonly queryContext?: string;
	};
}

const CONTEXT_EXCERPT_CHARS = 1200;
const MIN_EXCERPT_CHARS = 400;
const MAX_EXCERPT_CHARS = 3000;
const MAX_INACTIVE_SKILLS = 15;
const CONTEXT_FULL_BUDGET_RATIO = 0.5;

export function createSystemPromptBudgetItems(
	input: SystemPromptBudgetItemInput,
	resourceBudget: number,
): ContextBudgetItemV2[] {
	const items: ContextBudgetItemV2[] = [];
	const contextFullCount = input.options.includeFullContextFiles !== false ? input.contextFiles.length : 0;
	const excerptChars = computeExcerptChars(resourceBudget, contextFullCount);

	for (const contextFile of input.contextFiles) {
		const queryScore = scoreContextFileRelevance(
			{ path: contextFile.path, content: contextFile.content, isGlobal: contextFile.isGlobal ?? false },
			input.options.queryContext,
		);
		pushContextItems(items, contextFile, queryScore, excerptChars, input.options.includeFullContextFiles !== false);
	}

	const visibleSkills = input.skills.filter((skill) => !skill.disableModelInvocation);
	if (input.includeSkills && input.options.includeSkillInventory !== false && visibleSkills.length > 0) {
		pushSkillItems(items, visibleSkills, input.options);
	}
	return items;
}

function pushContextItems(
	items: ContextBudgetItemV2[],
	contextFile: ContextFile,
	queryScore: number,
	excerptChars: number,
	includeFullContextFiles: boolean,
): void {
	const scope = contextFile.isGlobal ? "parent" : "project";
	const tagName = contextFile.isGlobal ? "parent_instructions" : "project_instructions";
	items.push({
		id: `context-pointer:${contextFile.path}`,
		tier: contextFile.isGlobal ? "system" : "current-files",
		priority: contextFile.isGlobal ? "hard" : "high",
		relevance: (contextFile.isGlobal ? 1 : 0.8) * 0.4 + queryScore * 0.6,
		text: renderContextPointer(contextFile, scope),
	});
	if (!includeFullContextFiles) return;
	items.push({
		id: `context-full:${contextFile.path}`,
		tier: contextFile.isGlobal ? "system" : "current-files",
		priority: contextFile.isGlobal ? "high" : "medium",
		relevance: (contextFile.isGlobal ? 0.9 : 0.6) * 0.4 + queryScore * 0.6,
		redundancyKey: contextFile.path,
		sourceRef: {
			uri: pathToFileURL(contextFile.path).href,
			contentHash: fnv1aHex(contextFile.content),
			retrievable: true,
		},
		text: renderContextFull(contextFile, tagName, excerptChars),
	});
}

function pushSkillItems(
	items: ContextBudgetItemV2[],
	visibleSkills: readonly Skill[],
	options: SystemPromptBudgetItemInput["options"],
): void {
	items.push({ id: "skill-header", tier: "skills", priority: "hard", text: renderSkillHeader() });
	const activeSkillNames = new Set(options.activeSkillNames ?? []);
	const maxInactive = options.maxInactiveSkills ?? MAX_INACTIVE_SKILLS;
	for (const skill of visibleSkills.filter((skill) => activeSkillNames.has(skill.name))) {
		items.push(renderSkillBudgetItem(skill, "hard", 1));
	}

	const sortedInactive = visibleSkills
		.filter((skill) => !activeSkillNames.has(skill.name))
		.sort((a, b) => scoreSkillRelevance(b, options.queryContext) - scoreSkillRelevance(a, options.queryContext));
	for (const skill of sortedInactive.slice(0, maxInactive)) {
		items.push(renderSkillBudgetItem(skill, "low", Math.max(0.25, scoreSkillRelevance(skill, options.queryContext))));
	}
	items.push({ id: "skill-footer", tier: "skills", priority: "hard", text: "</available_skills>" });

	const omittedInactiveCount = sortedInactive.length - Math.min(sortedInactive.length, maxInactive);
	if (omittedInactiveCount > 0) {
		items.push({
			id: "skill-omitted-summary",
			tier: "skills",
			priority: "low",
			relevance: 0.1,
			text: `<!-- ${omittedInactiveCount} additional skills available. Use 'read' to load a specific skill file when a task matches. -->`,
		});
	}
}

function renderSkillBudgetItem(skill: Skill, priority: "hard" | "low", relevance: number): ContextBudgetItemV2 {
	return {
		id: `skill:${skill.name}`,
		tier: "skills",
		priority,
		relevance,
		redundancyKey: skill.name,
		text: renderSkillEntry(skill),
	};
}

function computeExcerptChars(resourceBudget: number, contextFullCount: number): number {
	if (contextFullCount <= 0) {
		return CONTEXT_EXCERPT_CHARS;
	}
	const allocatedTokens = Math.floor(resourceBudget * CONTEXT_FULL_BUDGET_RATIO) / contextFullCount;
	const estimatedChars = Math.floor(allocatedTokens * 4);
	return Math.max(MIN_EXCERPT_CHARS, Math.min(MAX_EXCERPT_CHARS, estimatedChars));
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
	return `<${tagName} path="${escapeXml(contextFile.path)}"${truncated}>\n${escapeXmlText(content)}\n</${tagName}>`;
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

export function escapeXmlText(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXml(str: string): string {
	return escapeXmlText(str).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
