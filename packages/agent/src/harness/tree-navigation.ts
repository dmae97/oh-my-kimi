/**
 * Tree-navigation helpers extracted from `AgentHarness.navigateTree`.
 *
 * These cover the two self-contained steps of a navigation — deciding where to
 * land, and producing a branch summary — so the harness method is left with
 * lifecycle staging, hook dispatch, and the session commit.
 */

import type { ImageContent, Model, RetryPolicy, TextContent } from "omk-ai";
import { generateBranchSummary } from "./compaction/branch-summarization.ts";
import { createSummarizationRetry, type SummarizationRetryEvent } from "./summarization-retry.ts";
import type { SessionTreeEntry } from "./types.ts";
import { AgentHarnessError } from "./types.ts";

function flattenText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export interface NavigationTarget {
	/** Leaf the session should move to. */
	readonly newLeafId: string | null;
	/** Original text of a user-authored target, handed back for re-editing. */
	readonly editorText?: string;
}

/**
 * Where a navigation lands. Targeting a user-authored entry rewinds to its
 * parent and returns that entry's text, so the caller can edit and resend it;
 * any other entry is entered directly.
 */
export function resolveNavigationTarget(targetEntry: SessionTreeEntry, targetId: string): NavigationTarget {
	if (targetEntry.type === "message" && targetEntry.message.role === "user") {
		return { newLeafId: targetEntry.parentId, editorText: flattenText(targetEntry.message.content) };
	}
	if (targetEntry.type === "custom_message") {
		return { newLeafId: targetEntry.parentId, editorText: flattenText(targetEntry.content) };
	}
	return { newLeafId: targetId };
}

export type BranchSummaryOutcome =
	| { readonly cancelled: true }
	| { readonly cancelled: false; readonly summary: string; readonly details: unknown };

/**
 * Summarize the entries being navigated away from. An aborted summary is a
 * cancellation, not a failure; every other summarization error is classified
 * as `branch_summary`.
 */
export async function runBranchSummary(input: {
	readonly entries: SessionTreeEntry[];
	readonly model: Model<any>;
	readonly apiKey: string;
	readonly headers?: Record<string, string>;
	readonly customInstructions?: string;
	readonly replaceInstructions?: boolean;
	readonly summarizationRetry: RetryPolicy | undefined;
	readonly emit: (event: SummarizationRetryEvent) => Promise<void> | void;
}): Promise<BranchSummaryOutcome> {
	const result = await generateBranchSummary(input.entries, {
		model: input.model,
		apiKey: input.apiKey,
		headers: input.headers,
		signal: new AbortController().signal,
		customInstructions: input.customInstructions,
		replaceInstructions: input.replaceInstructions,
		...createSummarizationRetry("branch_summary", input.summarizationRetry, input.emit),
	});
	if (!result.ok) {
		if (result.error.code === "aborted") return { cancelled: true };
		throw new AgentHarnessError("branch_summary", result.error.message, result.error);
	}
	return {
		cancelled: false,
		summary: result.value.summary,
		details: { readFiles: result.value.readFiles, modifiedFiles: result.value.modifiedFiles },
	};
}
