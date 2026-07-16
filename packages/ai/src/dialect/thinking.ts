import { partialSuffixOverlapAny } from "./coercion";
import { FencedThinkingScanner } from "./fenced-thinking";
import type { InbandScanEvent, InbandScanner } from "./types";

type Tag = { readonly open: string; readonly close: string; readonly fenced?: boolean };

/**
 * Every dialect's in-band thinking section in its canonical `renderThinking`
 * form (see the sibling `./*.ts` scanners). {@link ThinkingInbandScanner} heals
 * reasoning a model leaked into its visible text channel back into thinking
 * events, whichever dialect idiom the leak used.
 *
 * Plain (attribute-free) delimiters only — matching what `renderThinking`
 * emits and what models leak in practice. Attributed or namespaced XML thinking
 * tags (`<thinking signature="…">`, `antml:thinking`) are recovered by the owned
 * anthropic-dialect parser, not this text-channel healing fallback.
 */
const TAGS: readonly Tag[] = [
	{ open: "<think>", close: "</think>" }, // deepseek, glm, hermes, kimi, qwen3 (and anthropic/minimax/xml)
	{ open: "<thinking>", close: "</thinking>" }, // anthropic, minimax, xml
	{ open: "<scratchpad>", close: "</scratchpad>" }, // anthropic
	{ open: "```thinking\n", close: "```", fenced: true }, // gemini fenced thinking
	{ open: "<|channel>thought\n", close: "<channel|>" }, // gemma reasoning channel
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (rendered)
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (bare leak)
];
const OPENS = TAGS.map(tag => tag.open);

export class ThinkingInbandScanner implements InbandScanner {
	#buffer = "";
	#closeTag = "";
	#thinking = "";
	/** Fence-aware close-matcher while inside a ` ```thinking ` block; undefined otherwise. */
	#fenced: FencedThinkingScanner | undefined;
	/** Backtick count that closes the Markdown code span/fence we are inside; 0 when not in code. */
	#codeTicks = 0;

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		const events = this.#consume(true);
		if (this.#buffer.length === 0) return events;
		if (this.#closeTag) {
			this.#emitThinking(this.#buffer, events);
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else {
			events.push({ type: "text", text: this.#buffer });
		}
		this.#buffer = "";
		this.#closeTag = "";
		return events;
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		for (;;) {
			if (this.#fenced) {
				// Run even with an empty buffer so a held partial close flushes on final.
				const result = this.#fenced.feed(this.#buffer, final);
				this.#buffer = result.closed ? result.rest : "";
				this.#emitThinking(result.thinking, events);
				if (result.closed || final) {
					events.push({ type: "thinkingEnd", thinking: this.#thinking });
					this.#thinking = "";
					this.#closeTag = "";
					this.#fenced = undefined;
				}
				if (this.#fenced) break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#closeTag) {
				const close = this.#buffer.indexOf(this.#closeTag);
				if (close === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [this.#closeTag]);
					this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				this.#emitThinking(this.#buffer.slice(0, close), events);
				this.#buffer = this.#buffer.slice(close + this.#closeTag.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#closeTag = "";
				continue;
			}
			if (this.#codeTicks > 0) {
				// Inside a Markdown code span/fence: pass text through verbatim and
				// suppress reasoning-tag detection until the closing backtick run.
				const close = findBacktickRun(this.#buffer, 0, this.#codeTicks);
				if (close !== -1 && (final || close + this.#codeTicks < this.#buffer.length)) {
					const end = close + this.#codeTicks;
					events.push({ type: "text", text: this.#buffer.slice(0, end) });
					this.#buffer = this.#buffer.slice(end);
					this.#codeTicks = 0;
					continue;
				}
				// No committed close yet: emit text, holding a trailing backtick run
				// (it may still grow into — or past — the closing delimiter).
				const hold = final ? 0 : trailingBacktickRun(this.#buffer);
				const emit = this.#buffer.slice(0, this.#buffer.length - hold);
				if (emit.length > 0) events.push({ type: "text", text: emit });
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				if (final) this.#codeTicks = 0;
				break;
			}

			const hit = scanVisible(this.#buffer, final);
			if (hit.kind === "none") {
				events.push({ type: "text", text: this.#buffer });
				this.#buffer = "";
				break;
			}
			if (hit.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, hit.index) });
			if (hit.kind === "hold") {
				this.#buffer = this.#buffer.slice(hit.index);
				break;
			}
			if (hit.kind === "code") {
				events.push({ type: "text", text: this.#buffer.slice(hit.index, hit.index + hit.ticks) });
				this.#buffer = this.#buffer.slice(hit.index + hit.ticks);
				this.#codeTicks = hit.ticks;
				continue;
			}
			this.#buffer = this.#buffer.slice(hit.index + hit.tag.open.length);
			this.#closeTag = hit.tag.close;
			this.#thinking = "";
			if (hit.tag.fenced) this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
		}
		return events;
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}
}

/** Outcome of scanning idle visible text for the next reasoning-tag or code-span boundary. */
type VisibleHit =
	| { readonly kind: "tag"; readonly index: number; readonly tag: Tag }
	| { readonly kind: "code"; readonly index: number; readonly ticks: number }
	| { readonly kind: "hold"; readonly index: number }
	| { readonly kind: "none" };

/**
 * Walk idle visible text for the earliest boundary: a leaked reasoning-tag open,
 * a Markdown code-span/fence opener (a backtick run), or — when more chunks may
 * follow — a held partial delimiter at the buffer tail.
 *
 * Reasoning tags win at any position so the gemini ` ```thinking ` fence is
 * healed instead of being read as a code fence. Backtick runs enter code mode so
 * a literal `<think>` inside inline code or a fenced block stays visible text.
 */
function scanVisible(buffer: string, final: boolean): VisibleHit {
	for (let i = 0; i < buffer.length; i++) {
		const tag = TAGS.find(candidate => buffer.startsWith(candidate.open, i));
		if (tag) return { kind: "tag", index: i, tag };
		if (!final && isOpenPrefix(buffer, i)) return { kind: "hold", index: i };
		if (buffer[i] === "`") {
			const ticks = backtickRun(buffer, i);
			if (!final && i + ticks === buffer.length) return { kind: "hold", index: i };
			return { kind: "code", index: i, ticks };
		}
	}
	return { kind: "none" };
}

/** True when `buffer.slice(from)` is a strict prefix of some reasoning-tag open. */
function isOpenPrefix(buffer: string, from: number): boolean {
	const rest = buffer.length - from;
	return OPENS.some(open => open.length > rest && open.startsWith(buffer.slice(from)));
}

/** Length of the maximal backtick run beginning at `from`. */
function backtickRun(buffer: string, from: number): number {
	let end = from;
	while (end < buffer.length && buffer[end] === "`") end++;
	return end - from;
}

/** Index of the first maximal backtick run of exactly `ticks` at/after `from`, else -1. */
function findBacktickRun(buffer: string, from: number, ticks: number): number {
	for (let i = buffer.indexOf("`", from); i !== -1; i = buffer.indexOf("`", i)) {
		const run = backtickRun(buffer, i);
		if (run === ticks) return i;
		i += run;
	}
	return -1;
}

/** Length of a backtick run that ends at the buffer tail; 0 when the tail is not a backtick. */
function trailingBacktickRun(buffer: string): number {
	let start = buffer.length;
	while (start > 0 && buffer[start - 1] === "`") start--;
	return buffer.length - start;
}
