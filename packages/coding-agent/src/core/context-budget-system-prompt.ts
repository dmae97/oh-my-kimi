import {
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	type ContextBudgetItemV2,
	type PromptContextBudgetPlanV2,
	planPromptContextBudgetV2,
} from "./context-budget-governor-v2.ts";
import { createSystemPromptBudgetItems, escapeXml } from "./context-budget-system-prompt-items.ts";
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
	readonly plan: PromptContextBudgetPlanV2;
}

export function renderSystemPromptBudgetedResources(
	input: SystemPromptBudgetedResourcesInput,
): SystemPromptBudgetedResources {
	const tokenCounter =
		input.options.tokenCounter ?? createTokenCounterForMode(input.options.tokenizerMode ?? "fallback");
	const modelId = input.options.modelId ?? "unknown";
	const baseTokens = tokenCounter.countText(input.basePrompt, modelId).tokens;
	const resourceBudget = Math.max(0, input.options.maxPromptTokens - baseTokens);
	const items = createSystemPromptBudgetItems(input, resourceBudget);
	const plan = planPromptContextBudgetV2({
		maxTokens: resourceBudget,
		responseReserveTokens: input.options.responseReserveTokens ?? 0,
		modelId,
		policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
		query: input.options.queryContext,
		items,
		tokenCounter,
	});
	const included = new Set(plan.includedItemIds);
	const filtered = deduplicatePointerFull(items, included);
	const text = filtered
		.filter((item) => included.has(item.id))
		.map(
			(item) =>
				plan.selectedRepresentations.find((representation) => representation.itemId === item.id)?.text ?? item.text,
		)
		.join("\n")
		.trimEnd();
	const note = renderBudgetNote(plan, baseTokens);
	return { text: text ? `${text}\n${note}` : note, plan };
}

function renderBudgetNote(plan: PromptContextBudgetPlanV2, baseTokens: number): string {
	const omitted = plan.omittedItemIds.length;
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
	items: readonly ContextBudgetItemV2[],
	included: ReadonlySet<string>,
): readonly ContextBudgetItemV2[] {
	const includedFullPaths = new Set<string>();
	for (const item of items) {
		if (item.id.startsWith("context-full:") && included.has(item.id)) {
			const path = item.id.slice("context-full:".length);
			includedFullPaths.add(path);
		}
	}
	if (includedFullPaths.size === 0) {
		return items;
	}
	return items.filter((item) => {
		if (!item.id.startsWith("context-pointer:")) {
			return true;
		}
		const path = item.id.slice("context-pointer:".length);
		return !includedFullPaths.has(path);
	});
}
