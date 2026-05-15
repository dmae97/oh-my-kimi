import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import autoHandoffThresholdFocusPrompt from "./prompts/auto-handoff-threshold-focus.md" with { type: "text" };
import handoffDocumentPrompt from "./prompts/handoff-document.md" with { type: "text" };

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface HandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
}

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

export function renderHandoffPrompt(customInstructions?: string): string {
	return prompt.render(handoffDocumentPrompt, {
		additionalFocus: customInstructions,
	});
}

export function extractHandoffDocument(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = (message as AssistantMessage).content;
		const textParts = content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text);
		if (textParts.length > 0) return textParts.join("\n");
	}
	return undefined;
}

export function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

export function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}
