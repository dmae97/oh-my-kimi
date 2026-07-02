import { bareModelId, preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { getDialectDefinition } from "./factory";

const CLAUDE_FABLE_ID = /(?:^|[./])claude[-.]fable(?:[-.]|$)/i;

/**
 * Wrap a prior-turn reasoning string for demotion into native conversation
 * history — the cross-provider / cross-model case where the target cannot replay
 * it as a structured thinking block (verified end-to-end against Gemini 3: a
 * replayed unsigned `thought` part is schema-accepted but silently discarded —
 * neither recalled nor influencing generation).
 *
 * Fable is the exception: replaying prior reasoning inside `<thinking>` /
 * `antml:thinking`-style assistant text is treated as a reasoning-extraction
 * attempt and can train the next turn to leak thoughts, so Fable receives the
 * reasoning as markdown-italic assistant prose instead. Harmony and Gemma are
 * also exceptions: their `renderThinking` emits chat-template control tokens
 * (`<|channel|>analysis`, `<|channel>thought`) that must not appear inside a
 * structured native message, so they fall back to a plain `<think>` block. Every
 * other dialect's thinking form is inline-safe XML tags or a markdown fence.
 *
 * The result ends with a trailing newline so the block stays separated from the
 * turn's reply text when the wire encoder concatenates parts.
 *
 * Distinct from {@link DialectDefinition.renderThinking}, which targets the
 * owned-dialect *text transport* where those control tokens are legal.
 */
export function renderDemotedThinking(modelId: string, text: string): string {
	if (!text) return "";
	text = text.toWellFormed();
	const canonicalId = bareModelId(modelId);
	const dialect = preferredDialect(modelId);
	if (CLAUDE_FABLE_ID.test(canonicalId)) return `_Hmm. ${text}_\n`;
	if (dialect === "harmony" || dialect === "gemma") return `<think>\n${text}\n</think>\n`;
	return `${getDialectDefinition(dialect).renderThinking(text)}\n`;
}
