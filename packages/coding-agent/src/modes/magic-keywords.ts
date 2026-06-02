import { highlightOrchestrate } from "./orchestrate";
import { highlightUltrathink } from "./ultrathink";
import { highlightWorkflow } from "./workflow";

/**
 * Gradient-highlight every magic keyword ("ultrathink", "orchestrate",
 * "workflow") that appears as standalone prose, skipping any occurrence inside a
 * code block, inline code span, or XML/HTML section. Each highlighter paints its
 * own keyword with its own gradient, so chaining is order-independent — the
 * earlier passes only inject zero-width SGR escapes (no backticks or angle
 * brackets), which never confuse the later passes' markdown masking.
 *
 * `resetTo` is the SGR foreground sequence restored after each painted keyword;
 * pass the surrounding text color when decorating already-colored content (e.g.
 * a themed message bubble) so the gradient does not bleed into the rest of the
 * line. Defaults to a plain foreground reset for default-colored editor text.
 */
export function highlightMagicKeywords(text: string, resetTo?: string): string {
	return highlightWorkflow(highlightOrchestrate(highlightUltrathink(text, resetTo), resetTo), resetTo);
}
