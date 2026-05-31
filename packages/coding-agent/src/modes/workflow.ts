import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflow" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden {@link WORKFLOW_NOTICE} that steers the model to
 * author a deterministic multi-subagent workflow in eval cells (agent/parallel/
 * pipeline). Matching is whitespace-delimited and case-sensitive (lowercase
 * only) — "workflow"/"workflows" trigger, but "workflowed", "Workflow", and
 * "workflow.ts" never do.
 */

// Detection: lowercase keyword (singular or plural) flanked by whitespace or a string edge. Non-global so `.test` stays stateless.
const WORKFLOW_WORD = /(?<!\S)workflows?(?!\S)/;

/** Hidden system notice appended after a user message that mentions "workflow". */
export const WORKFLOW_NOTICE: string = workflowNotice.trim();

/**
 * Whether `text` contains the standalone keyword "workflow"/"workflows"
 * (lowercase, whitespace-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

/**
 * Highlight every standalone "workflow"/"workflows" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflow/,
	highlight: /(?<!\S)workflows?(?!\S)/g,
	stops: 14,
	hue: t => 30 + t * 120,
});
