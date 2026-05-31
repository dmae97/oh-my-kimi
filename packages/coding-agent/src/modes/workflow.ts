import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter } from "./gradient-highlight";

/**
 * "workflow" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden {@link WORKFLOW_NOTICE} that steers the model to
 * author a deterministic multi-subagent workflow in eval cells (agent/parallel/
 * pipeline). Matching is word-bounded and case-insensitive — the singular and
 * plural both trigger, but "workflowed"/"reworkflow" never do.
 */

// Detection: standalone keyword (singular or plural), any case. Non-global so `.test` stays stateless.
const WORKFLOW_WORD = /\bworkflows?\b/i;

/** Hidden system notice appended after a user message that mentions "workflow". */
export const WORKFLOW_NOTICE: string = workflowNotice.trim();

/** Whether `text` contains the standalone keyword "workflow"/"workflows" (any case). */
export function containsWorkflow(text: string): boolean {
	return WORKFLOW_WORD.test(text);
}

/**
 * Highlight every standalone "workflow"/"workflows" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: (text: string) => string = createGradientHighlighter({
	probe: /workflow/i,
	highlight: /\bworkflows?\b/gi,
	stops: 14,
	hue: t => 30 + t * 120,
});
