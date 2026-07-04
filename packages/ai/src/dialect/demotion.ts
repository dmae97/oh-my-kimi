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
 * Fable is the exception: Anthropic's `reasoning_extraction` classifier blocks
 * requests that replay prior reasoning inside `<thinking>` / `antml:thinking`
 * tags OR the older `_Hmm. …_` italic envelope — it reads the wrapped
 * chain-of-thought as an attempt to duplicate model outputs and refuses the
 * whole turn. Fable therefore receives prior reasoning as bare assistant prose:
 * no tag, no `_Hmm.` wrapper, no trailing newline.
 * Heat is cumulative (block count and early-conversation position also raise
 * it), so this lowers per-block signal but does not license unbounded replay.
 * Harmony and Gemma are also exceptions: their `renderThinking` emits
 * chat-template control tokens (`<|channel|>analysis`, `<|channel>thought`)
 * that must not appear inside a structured native message, so they fall back to
 * a plain `<think>` block. Every other dialect's thinking form is inline-safe
 * XML tags or a markdown fence.
 *
 * The result does not append a delimiter; callers that flatten adjacent blocks
 * into a single string must insert their own separator.
 *
 * Distinct from {@link DialectDefinition.renderThinking}, which targets the
 * owned-dialect *text transport* where those control tokens are legal.
 */
export function renderDemotedThinking(modelId: string, text: string): string {
	if (!text) return "";
	text = text.toWellFormed();
	const canonicalId = bareModelId(modelId);
	const dialect = preferredDialect(modelId);
	if (CLAUDE_FABLE_ID.test(canonicalId)) return text;
	if (dialect === "harmony" || dialect === "gemma") return `<think>\n${text}\n</think>`;
	return getDialectDefinition(dialect).renderThinking(text);
}
