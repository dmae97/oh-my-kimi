import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";

export const MAX_ADVISER_TEXT_CHARS = 24_000;
export const ADVISER_STREAM_CHAR_LIMIT = 64_000;
export const SYNTHESIS_STREAM_CHAR_LIMIT = 128_000;

export class MoaAdvisorError extends Error {
	readonly assistantMessage: AssistantMessage | undefined;

	constructor(assistantMessage?: AssistantMessage) {
		super("MoA adviser failed");
		this.name = "MoaAdvisorError";
		this.assistantMessage = assistantMessage;
	}
}

export function generatedChars(event: AssistantMessageEvent): number {
	return event.type === "text_delta" || event.type === "thinking_delta" ? event.delta.length : 0;
}

export function messageGeneratedChars(message: AssistantMessage): number {
	return message.content.reduce((total, content) => {
		if (content.type === "text") return total + content.text.length;
		if (content.type === "thinking") return total + content.thinking.length;
		return total;
	}, 0);
}

export function truncateGeneratedContent(message: AssistantMessage, maxChars: number): AssistantMessage {
	let remaining = maxChars;
	const boundedContent: AssistantMessage["content"] = [];
	for (const content of message.content) {
		if (content.type === "text") {
			const text = content.text.slice(0, remaining);
			remaining -= text.length;
			boundedContent.push({ ...content, text });
		}
		if (content.type === "thinking") {
			const thinking = content.thinking.slice(0, remaining);
			remaining -= thinking.length;
			boundedContent.push({ ...content, thinking });
		}
	}
	return { ...message, content: boundedContent };
}

export function boundedAdviserText(message: AssistantMessage): string {
	const marker = "\n[truncated]";
	const text = message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	if (text.length <= MAX_ADVISER_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_ADVISER_TEXT_CHARS - marker.length)}${marker}`;
}

export function truncateDeltaEvent(
	event: Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>,
	remaining: number,
	maxChars: number,
): AssistantMessageEvent {
	const delta = event.delta.slice(0, remaining);
	const partial = truncateGeneratedContent(event.partial, maxChars);
	return event.type === "text_delta" ? { ...event, delta, partial } : { ...event, delta, partial };
}

export function truncatePartialEvent(event: AssistantMessageEvent, maxChars: number): AssistantMessageEvent {
	if (!("partial" in event)) return event;
	const partial = truncateGeneratedContent(event.partial, maxChars);
	if (event.type === "text_end") {
		const content = partial.content[event.contentIndex];
		return { ...event, partial, content: content?.type === "text" ? content.text : "" };
	}
	if (event.type === "thinking_end") {
		const content = partial.content[event.contentIndex];
		return { ...event, partial, content: content?.type === "thinking" ? content.thinking : "" };
	}
	return { ...event, partial };
}

export function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

export interface BoundedSynthesisResult {
	readonly terminalForwarded: boolean;
	readonly cappedMessage: AssistantMessage | undefined;
}

export async function drainBoundedSynthesis(
	stream: AssistantMessageEventStream,
	limitAbort: AbortController,
	forward: (event: AssistantMessageEvent) => boolean,
): Promise<BoundedSynthesisResult> {
	let terminalForwarded = false;
	let cappedMessage: AssistantMessage | undefined;
	let generated = 0;
	for await (const event of stream) {
		const terminal = terminalMessage(event);
		if (cappedMessage) {
			if (terminal) cappedMessage = { ...cappedMessage, usage: terminal.usage };
			if (terminal) break;
			continue;
		}
		if (terminal && messageGeneratedChars(terminal) > SYNTHESIS_STREAM_CHAR_LIMIT) {
			const cappedTerminal = truncateGeneratedContent(terminal, SYNTHESIS_STREAM_CHAR_LIMIT);
			if (event.type === "error") terminalForwarded = forward({ ...event, error: cappedTerminal });
			else cappedMessage = cappedTerminal;
			break;
		}
		const increment = generatedChars(event);
		const partialChars = "partial" in event ? messageGeneratedChars(event.partial) : 0;
		if (
			"partial" in event &&
			(partialChars >= SYNTHESIS_STREAM_CHAR_LIMIT || generated + increment >= SYNTHESIS_STREAM_CHAR_LIMIT)
		) {
			const cappedEvent =
				event.type === "text_delta" || event.type === "thinking_delta"
					? truncateDeltaEvent(event, SYNTHESIS_STREAM_CHAR_LIMIT - generated, SYNTHESIS_STREAM_CHAR_LIMIT)
					: truncatePartialEvent(event, SYNTHESIS_STREAM_CHAR_LIMIT);
			forward(cappedEvent);
			cappedMessage = truncateGeneratedContent(event.partial, SYNTHESIS_STREAM_CHAR_LIMIT);
			limitAbort.abort();
			continue;
		}
		terminalForwarded = forward(event);
		generated += increment;
		if (terminalForwarded) break;
	}
	return { terminalForwarded, cappedMessage };
}

export async function drainBoundedAdviser(
	stream: AssistantMessageEventStream,
	limitAbort: AbortController,
): Promise<AssistantMessage> {
	let result: AssistantMessage | undefined;
	let cappedResult: AssistantMessage | undefined;
	let toolViolation: AssistantMessage | undefined;
	let generated = 0;
	for await (const event of stream) {
		const terminal = terminalMessage(event);
		const eventMessage = terminal ?? ("partial" in event ? event.partial : undefined);
		if (toolViolation) {
			if (terminal) {
				throw new MoaAdvisorError(truncateGeneratedContent(terminal, ADVISER_STREAM_CHAR_LIMIT));
			}
			continue;
		}
		if (event.type.startsWith("toolcall_") || eventMessage?.content.some((content) => content.type === "toolCall")) {
			toolViolation = eventMessage;
			limitAbort.abort();
			if (terminal) {
				throw new MoaAdvisorError(truncateGeneratedContent(terminal, ADVISER_STREAM_CHAR_LIMIT));
			}
			continue;
		}
		if (cappedResult && terminal) {
			return { ...cappedResult, usage: terminal.usage, stopReason: "length" };
		}
		if (event.type === "error") {
			throw new MoaAdvisorError(truncateGeneratedContent(event.error, ADVISER_STREAM_CHAR_LIMIT));
		}
		if (event.type === "done") {
			if (messageGeneratedChars(event.message) <= ADVISER_STREAM_CHAR_LIMIT) return event.message;
			return { ...truncateGeneratedContent(event.message, ADVISER_STREAM_CHAR_LIMIT), stopReason: "length" };
		}
		if ("partial" in event && !cappedResult) result = event.partial;
		generated += generatedChars(event);
		const partialChars = "partial" in event ? messageGeneratedChars(event.partial) : 0;
		if (
			!cappedResult &&
			(generated >= ADVISER_STREAM_CHAR_LIMIT || partialChars >= ADVISER_STREAM_CHAR_LIMIT) &&
			result
		) {
			cappedResult = truncateGeneratedContent(result, ADVISER_STREAM_CHAR_LIMIT);
			limitAbort.abort();
		}
	}
	throw new MoaAdvisorError(toolViolation ?? cappedResult ?? result);
}
