/**
 * Central live healing for leaked reasoning markup in the visible text channel.
 *
 * Some providers emit their canonical reasoning idioms (` ```thinking `,
 * `<think>`, Gemma/Harmony channels, …) into the *visible* text stream instead
 * of a structured thinking part. {@link wrapLeakedThinkingStream} re-projects any
 * provider stream into a fresh {@link AssistantMessageEventStream}, splitting the
 * leaked fences out into proper `thinking` blocks *live* as deltas arrive — so
 * every provider gets the same healing, not just the three with provider-local
 * {@link StreamMarkupHealing} loops.
 *
 * The healing is idempotent: a second pass over already-clean text finds no
 * fences, so wrapping a provider that already heals (or wrapping twice) is a
 * harmless pass-through. Signatures are load-bearing for Google/Gemini/Vertex
 * thought round-tripping, so text sub-blocks carry the source `textSignature`,
 * forwarded thinking blocks their `thinkingSignature`, and forwarded tool calls
 * their `thoughtSignature`.
 *
 * Modeled on {@link wrapInbandToolStream} / `InbandStreamProjector` in
 * `../dialect/owned-stream.ts`, minus all in-band tool-call grammar: tool-call
 * events are forwarded verbatim.
 */

import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../types";
import { AssistantMessageEventStream } from "./event-stream";
import { StreamMarkupHealing, type StreamMarkupHealingEvent } from "./stream-markup-healing";

/**
 * Wrap a provider stream so leaked reasoning fences are healed into thinking
 * blocks live, for every provider. Returns a new stream that re-projects the
 * inner one; the inner stream is fully consumed.
 */
export function wrapLeakedThinkingStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			let projector: LeakedThinkingProjector | undefined;
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						projector = new LeakedThinkingProjector(out, event.partial);
						break;
					case "text_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.text(event.delta, block?.type === "text" ? block.textSignature : undefined);
						break;
					}
					case "thinking_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.thinking(event.delta, block?.type === "thinking" ? block.thinkingSignature : undefined);
						break;
					}
					case "toolcall_start": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.toolStart(event.contentIndex, block?.type === "toolCall" ? block.name : "");
						break;
					}
					case "toolcall_delta":
						projector?.toolDelta(event.contentIndex, event.delta);
						break;
					case "toolcall_end":
						projector?.toolEnd(event.contentIndex, event.toolCall);
						break;
					case "done": {
						projector ??= new LeakedThinkingProjector(out, event.message);
						const content = projector.finish(event.message);
						out.push({ type: "done", reason: event.reason, message: { ...event.message, content } });
						return;
					}
					case "error": {
						projector ??= new LeakedThinkingProjector(out, event.error);
						const content = projector.finish(event.error);
						out.push({ type: "error", reason: event.reason, error: { ...event.error, content } });
						return;
					}
					// text_start/text_end/thinking_start/thinking_end are ignored: the
					// projector owns block boundaries (matches wrapInbandToolStream).
				}
			}
			// Inner ended via end(result) without a terminal event.
			if (!out.done) {
				const result = await inner.result();
				projector ??= new LeakedThinkingProjector(out, result);
				const content = projector.finish(result);
				out.end({ ...result, content });
			}
		} catch (err) {
			if (!out.done) out.fail(err);
		}
	})();
	return out;
}

type OpenBlock = { index: number } | undefined;

/**
 * Re-projects an inner stream's events into `out`, healing leaked reasoning out
 * of the visible text channel while forwarding native thinking and tool calls.
 */
class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #healer = new StreamMarkupHealing({ pattern: "thinking" });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;
	/** Total visible text length fed to the healer, to replay any un-streamed tail in {@link finish}. */
	#fedLen = 0;
	/** Latest non-undefined text signature seen, stamped onto held-back text flushed later. */
	#lastTextSignature: string | undefined;
	/** Forwarded native tool calls, keyed by the inner stream's `contentIndex`. */
	#toolBlocks = new Map<number, { index: number }>();

	constructor(out: AssistantMessageEventStream, seed: AssistantMessage) {
		this.#out = out;
		this.#partial = { ...seed, content: [] };
		this.#out.push({ type: "start", partial: this.#partial });
	}

	/** Feed a visible-text delta through the healer, splitting leaked fences live. */
	text(delta: string, signature: string | undefined): void {
		this.#fedLen += delta.length;
		if (signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feedEvents(delta), this.#lastTextSignature);
	}

	/** Forward a native thinking delta, preserving its signature. */
	thinking(delta: string, signature: string | undefined): void {
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += delta;
		if (signature !== undefined) block.thinkingSignature = signature;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#partial });
	}

	/** Forward a native tool call's start, releasing any held-back text first. */
	toolStart(srcIndex: number, name: string): void {
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block: ToolCall = { type: "toolCall", id: "", name, arguments: {} };
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#toolBlocks.set(srcIndex, { index });
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
	}

	toolDelta(srcIndex: number, delta: string): void {
		const entry = this.#toolBlocks.get(srcIndex);
		if (!entry) return;
		this.#out.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: this.#partial });
	}

	toolEnd(srcIndex: number, toolCall: ToolCall): void {
		const entry = this.#toolBlocks.get(srcIndex);
		if (entry) {
			const block = this.#partial.content[entry.index] as ToolCall;
			Object.assign(block, toolCall);
			this.#out.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: block, partial: this.#partial });
			this.#toolBlocks.delete(srcIndex);
			return;
		}
		// `end` without a matching `start` — release held text, then forward whole.
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block: ToolCall = { ...toolCall };
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
		this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
	}

	/**
	 * Finalize: replay any un-streamed visible-text tail from `message.content`,
	 * flush held-back fragments, close open blocks, and return the healed content.
	 */
	finish(message: AssistantMessage): AssistantMessage["content"] {
		let fullText = "";
		let tailSignature: string | undefined;
		for (const block of message.content) {
			if (block.type === "text") {
				fullText += block.text;
				tailSignature = block.textSignature;
			}
		}
		if (tailSignature !== undefined) this.#lastTextSignature = tailSignature;
		if (fullText.length > this.#fedLen) {
			this.#apply(this.#healer.feedEvents(fullText.slice(this.#fedLen)), this.#lastTextSignature);
		}
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		return this.#partial.content;
	}

	#apply(events: readonly StreamMarkupHealingEvent[], signature?: string): void {
		for (const event of events) {
			if (event.type === "text") this.#emitText(event.text, signature);
			else if (event.type === "thinking") this.#emitHealedThinking(event.thinking);
		}
	}

	#emitText(text: string, signature: string | undefined): void {
		if (text.length === 0) return;
		this.#closeThinking();
		if (!this.#text) {
			const block: TextContent =
				signature === undefined ? { type: "text", text: "" } : { type: "text", text: "", textSignature: signature };
			this.#partial.content.push(block);
			this.#text = { index: this.#partial.content.length - 1 };
			this.#out.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#partial });
		} else if (signature !== undefined) {
			(this.#partial.content[this.#text.index] as TextContent).textSignature = signature;
		}
		const block = this.#partial.content[this.#text.index] as TextContent;
		block.text += text;
		this.#out.push({ type: "text_delta", contentIndex: this.#text.index, delta: text, partial: this.#partial });
	}

	/** Healed (leaked) thinking carries no signature, matching the source fence. */
	#emitHealedThinking(text: string): void {
		if (text.length === 0) return;
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += text;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: this.#partial });
	}

	#openThinking(): number {
		this.#closeText();
		if (!this.#thinking) {
			this.#partial.content.push({ type: "thinking", thinking: "" });
			this.#thinking = { index: this.#partial.content.length - 1 };
			this.#out.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#partial });
		}
		return this.#thinking.index;
	}

	#closeText(): void {
		if (!this.#text) return;
		const block = this.#partial.content[this.#text.index] as TextContent;
		this.#out.push({ type: "text_end", contentIndex: this.#text.index, content: block.text, partial: this.#partial });
		this.#text = undefined;
	}

	#closeThinking(): void {
		if (!this.#thinking) return;
		const block = this.#partial.content[this.#thinking.index] as ThinkingContent;
		this.#out.push({
			type: "thinking_end",
			contentIndex: this.#thinking.index,
			content: block.thinking,
			partial: this.#partial,
		});
		this.#thinking = undefined;
	}
}
