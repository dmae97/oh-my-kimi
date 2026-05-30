import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import { createGradientHighlighter } from "./gradient-highlight";

/**
 * "ultrathink" keyword support, mirroring Claude Code's affordance.
 *
 * Typing the standalone word in the input editor paints it with a rainbow
 * gradient ({@link highlightUltrathink}); submitting a message that mentions it
 * appends a hidden {@link ULTRATHINK_NOTICE} nudging the model toward careful
 * multi-step reasoning. Matching is word-bounded and case-insensitive, so
 * "ultrathinking"/"ultrathinks" never trigger either behavior.
 */

// Detection: standalone keyword, any case. Non-global so `.test` stays stateless.
const ULTRATHINK_WORD = /\bultrathink\b/i;

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

/** Whether `text` contains the standalone keyword "ultrathink" (any case). */
export function containsUltrathink(text: string): boolean {
	return ULTRATHINK_WORD.test(text);
}

/**
 * Rainbow-highlight every standalone "ultrathink" in `text` for editor display.
 * Sweeps red→violet (hue 0..330), stopping short of the wrap back to red so the
 * gradient resolves smoothly regardless of casing or match length.
 */
export const highlightUltrathink: (text: string) => string = createGradientHighlighter({
	probe: /ultrathink/i,
	highlight: /\bultrathink\b/gi,
	stops: 14,
	hue: t => t * 330,
});
