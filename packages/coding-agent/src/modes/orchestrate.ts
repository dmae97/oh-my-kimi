import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import { createGradientHighlighter } from "./gradient-highlight";

/**
 * "orchestrate" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a cool
 * teal→violet gradient ({@link highlightOrchestrate}); submitting a message that
 * mentions it appends a hidden {@link ORCHESTRATE_NOTICE} that switches the model
 * into multi-agent orchestration mode. Matching is word-bounded and
 * case-insensitive, so "orchestrated"/"orchestrating" never trigger either
 * behavior. Replaces the former `/orchestrate` slash command.
 */

// Detection: standalone keyword, any case. Non-global so `.test` stays stateless.
const ORCHESTRATE_WORD = /\borchestrate\b/i;

/** Hidden system notice appended after a user message that mentions "orchestrate". */
export const ORCHESTRATE_NOTICE: string = orchestrateNotice.trim();

/** Whether `text` contains the standalone keyword "orchestrate" (any case). */
export function containsOrchestrate(text: string): boolean {
	return ORCHESTRATE_WORD.test(text);
}

/**
 * Highlight every standalone "orchestrate" in `text` for editor display with a
 * cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's
 * full-spectrum rainbow.
 */
export const highlightOrchestrate: (text: string) => string = createGradientHighlighter({
	probe: /orchestrate/i,
	highlight: /\borchestrate\b/gi,
	stops: 14,
	hue: t => 150 + t * 130,
});
