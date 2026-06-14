import type { AssistantMessage } from "@oh-my-pi/pi-ai";

type AssistantContentBlock = AssistantMessage["content"][number];
type ThinkingBlock = Extract<AssistantContentBlock, { type: "thinking" }>;

function isDotOnlyThinking(text: string): boolean {
	let sawDot = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x2e || code === 0x2026) {
			sawDot = true;
			continue;
		}
		if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
		return false;
	}
	return sawDot;
}

/**
 * Returns the operator-visible thinking text for a block.
 *
 * Some OpenAI-compatible reasoning gateways require a non-empty
 * `reasoning_content` field on historical assistant tool-call turns even when
 * the model did not emit any reasoning. The provider adapter uses a single dot
 * as the wire-only placeholder those gateways accept; if that value is later
 * replayed or echoed as a thinking block, it should not render as model thought.
 */
export function getVisibleThinkingText(block: ThinkingBlock): string {
	const text = block.thinking.trim();
	if (text.length === 0) return "";
	return isDotOnlyThinking(text) ? "" : text;
}

export function hasVisibleThinking(block: ThinkingBlock): boolean {
	return getVisibleThinkingText(block).length > 0;
}
