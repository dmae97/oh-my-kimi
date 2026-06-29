import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getSegmenter } from "@oh-my-pi/pi-tui";
import { LRUCache } from "lru-cache/raw";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import type { AssistantMessageComponent } from "../components/assistant-message";

export const STREAMING_REVEAL_FRAME_MS = 1000 / 30;
export const MIN_STEP = 3;
export const CATCHUP_FRAMES = 8;

type AssistantContentBlock = AssistantMessage["content"][number];
type DisplayThinkingContentBlock = Extract<AssistantContentBlock, { type: "thinking" }> & { rawThinking?: string };
type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent">;

type StreamingRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	getProseOnlyThinking(): boolean;
	requestRender(): void;
};

const graphemeCountCache = new LRUCache<string, number>({ max: 128 });

function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	const cached = graphemeCountCache.get(text);
	if (cached !== undefined) return cached;
	let count = 0;
	for (const _segment of getSegmenter().segment(text)) {
		count += 1;
	}
	graphemeCountCache.set(text, count);
	return count;
}

/** Count graphemes of `text` from code-unit offset `start`, also reporting the
 *  start offset of the final grapheme (where an append could extend a cluster). */
function countGraphemesFrom(text: string, start: number): { count: number; tailStart: number } {
	let count = 0;
	let tailStart = start;
	for (const seg of getSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		tailStart = start + seg.index;
	}
	return { count, tailStart };
}

/** Memoizes per-block grapheme counts across reveal ticks. Streaming blocks only
 *  grow by appending, and an append can only alter the final grapheme cluster of
 *  the previous text, so only the suffix from that cluster needs re-segmenting. */
export class BlockUnitCounter {
	#entries = new Map<number, { text: string; count: number; tailStart: number }>();
	// Per-block slice cursor: the code-unit offset of the `units`-th grapheme and
	// the start of that final grapheme cluster, so a reveal tick resumes from the
	// boundary cluster instead of re-segmenting from offset 0.
	#sliceEntries = new Map<number, { text: string; units: number; offset: number; lastStart: number }>();

	count(index: number, text: string): number {
		const entry = this.#entries.get(index);
		if (entry !== undefined) {
			if (entry.text === text) return entry.count;
			if (entry.count > 0 && text.length > entry.text.length && text.startsWith(entry.text)) {
				const tail = countGraphemesFrom(text, entry.tailStart);
				const next = { text, count: entry.count - 1 + tail.count, tailStart: tail.tailStart };
				this.#entries.set(index, next);
				return next.count;
			}
		}
		const full = countGraphemesFrom(text, 0);
		this.#entries.set(index, { text, count: full.count, tailStart: full.tailStart });
		return full.count;
	}

	/** Slice `text` to its first `units` graphemes, resuming from the cached
	 *  boundary cluster when `text` is unchanged or has only grown (append-only,
	 *  the streaming case). The reveal position advances monotonically while the
	 *  target text is fixed or appending, so each tick segments only the new
	 *  graphemes rather than the whole revealed prefix. */
	slice(index: number, text: string, units: number): string {
		if (units <= 0 || text.length === 0) return "";
		const e = this.#sliceEntries.get(index);
		if (e !== undefined && text.startsWith(e.text)) {
			if (text === e.text && units === e.units) {
				// Exact cache hit — text unchanged, so the cached offset is valid.
				return e.offset >= text.length ? text : text.slice(0, e.offset);
			}
			if (units >= e.units) {
				// Text unchanged or only appended, and the reveal point hasn't moved
				// backward. Resume from the boundary cluster: an append can EXTEND that
				// final cluster (e.g. "a" → "a\u0301"), so even an unchanged unit count
				// must re-segment it rather than trust a now-stale offset.
				return this.#advanceSlice(index, text, units, e);
			}
			// units < e.units: reveal shrank (rare, e.g. a resync clamp) — re-segment.
		}
		return this.#fullSlice(index, text, units);
	}

	/** Extend the cached slice (e.units graphemes) to `units` by segmenting only
	 *  from the boundary cluster start. An append can extend that final cluster,
	 *  so the first segment from `lastStart` is re-counted (mirroring `count`'s
	 *  tailStart logic) rather than blindly trusting e.offset. */
	#advanceSlice(
		index: number,
		text: string,
		units: number,
		e: { text: string; units: number; offset: number; lastStart: number },
	): string {
		const base = e.lastStart;
		if (base >= text.length) return text;
		const tail = base === 0 ? text : text.slice(base);
		// Grapheme #e.units is the first segment from `base`; reach through #units.
		const need = units - e.units + 1;
		let consumed = 0;
		let segStart = 0;
		let segEnd = 0;
		for (const seg of getSegmenter().segment(tail)) {
			segStart = seg.index;
			segEnd = seg.index + seg.segment.length;
			if (++consumed >= need) break;
		}
		if (consumed === 0) return text;
		const actualUnits = e.units - 1 + consumed;
		const newOffset = base + segEnd;
		const newLastStart = base + segStart;
		this.#sliceEntries.set(index, { text, units: actualUnits, offset: newOffset, lastStart: newLastStart });
		return newOffset >= text.length ? text : text.slice(0, newOffset);
	}

	#fullSlice(index: number, text: string, units: number): string {
		let count = 0;
		let segStart = 0;
		let segEnd = 0;
		for (const seg of getSegmenter().segment(text)) {
			count++;
			segStart = seg.index;
			segEnd = seg.index + seg.segment.length;
			if (count >= units) break;
		}
		this.#sliceEntries.set(index, { text, units: count, offset: segEnd, lastStart: segStart });
		return segEnd === 0 || segEnd >= text.length ? text : text.slice(0, segEnd);
	}

	reset(): void {
		this.#entries.clear();
		this.#sliceEntries.clear();
	}
}

function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	let count = 0;
	for (const { index, segment } of getSegmenter().segment(text)) {
		count += 1;
		if (count >= units) {
			const end = index + segment.length;
			return end >= text.length ? text : text.slice(0, end);
		}
	}
	return text;
}

export function visibleUnits(message: AssistantMessage, hideThinking: boolean, proseOnly = true): number {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += countGraphemes(block.text);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				total += countGraphemes(formatted);
			}
		}
	}
	return total;
}

function revealTextBlock(
	block: Extract<AssistantContentBlock, { type: "text" }>,
	remaining: number,
	units: number,
	index: number,
	sliceOf: (index: number, text: string, units: number) => string,
): AssistantContentBlock {
	if (remaining <= 0) return block.text.length === 0 ? block : { ...block, text: "" };
	if (remaining >= units) return block;
	return { ...block, text: sliceOf(index, block.text, remaining) };
}

function revealThinkingBlock(
	block: Extract<AssistantContentBlock, { type: "thinking" }>,
	remaining: number,
	units: number,
	index: number,
	sliceOf: (index: number, text: string, units: number) => string,
): AssistantContentBlock {
	if (remaining <= 0) return block.thinking.length === 0 ? block : { ...block, thinking: "" };
	if (remaining >= units) return block;
	return { ...block, thinking: sliceOf(index, block.thinking, remaining) };
}

export function buildDisplayMessage(
	target: AssistantMessage,
	revealed: number,
	hideThinking: boolean,
	proseOnly = true,
	countOf: (index: number, text: string) => number = (_index, text) => countGraphemes(text),
	sliceOf: (index: number, text: string, units: number) => string = (_index, text, units) =>
		sliceGraphemes(text, units),
): AssistantMessage {
	let remaining = Math.max(0, Math.floor(revealed));
	const content: AssistantContentBlock[] = [];
	for (let i = 0; i < target.content.length; i++) {
		const block = target.content[i]!;
		if (block.type === "text") {
			const units = countOf(i, block.text);
			content.push(revealTextBlock(block, remaining, units, i, sliceOf));
			remaining = Math.max(0, remaining - units);
		} else if (block.type === "thinking" && !hideThinking) {
			const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
			if (hasDisplayableThinking(block.thinking, formatted)) {
				const units = countOf(i, formatted);
				const displayBlock: DisplayThinkingContentBlock = {
					...block,
					thinking: formatted,
					rawThinking: block.thinking,
				};
				content.push(revealThinkingBlock(displayBlock, remaining, units, i, sliceOf));
				remaining = Math.max(0, remaining - units);
			} else {
				content.push(block);
			}
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}

export function nextStep(backlog: number): number {
	return Math.max(MIN_STEP, Math.ceil(Math.max(0, backlog) / CATCHUP_FRAMES));
}

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #getProseOnlyThinking: () => boolean;
	readonly #requestRender: () => void;
	#target: AssistantMessage | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#revealed = 0;
	#hideThinkingBlock = false;
	#proseOnlyThinking = true;
	#smoothStreaming = true;
	readonly #unitCounter = new BlockUnitCounter();
	readonly #countOf = (index: number, text: string): number => this.#unitCounter.count(index, text);
	readonly #sliceOf = (index: number, text: string, units: number): string =>
		this.#unitCounter.slice(index, text, units);

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#getProseOnlyThinking = options.getProseOnlyThinking;
		this.#requestRender = options.requestRender;
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#revealed = 0;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			component.updateContent(
				buildDisplayMessage(
					message,
					total,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{ transient: true },
			);
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			component.updateContent(
				buildDisplayMessage(
					message,
					this.#revealed,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{
					transient: true,
				},
			);
			return;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	setTarget(message: AssistantMessage): void {
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		this.#smoothStreaming = this.#getSmoothStreaming();
		if (!this.#component) return;
		if (!this.#smoothStreaming) {
			const total = this.#visibleUnits(message);
			this.#component.updateContent(
				buildDisplayMessage(
					message,
					total,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{ transient: true },
			);
			return;
		}
		const total = this.#visibleUnits(message);
		if (message.content.some(block => block.type === "toolCall")) {
			// A tool call is a transcript-order boundary: finish any leading
			// assistant text before EventController renders the separate tool card.
			this.#revealed = total;
			this.#stopTimer();
			this.#component.updateContent(
				buildDisplayMessage(
					message,
					this.#revealed,
					this.#hideThinkingBlock,
					this.#proseOnlyThinking,
					this.#countOf,
					this.#sliceOf,
				),
				{
					transient: true,
				},
			);
			return;
		}
		if (this.#revealed > total) {
			this.#revealed = total;
		}
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#unitCounter.reset();
	}

	/**
	 * Re-read cached visibility flags (hideThinkingBlock, proseOnlyThinking)
	 * and re-render the current target. Called when the thinking level changes
	 * mid-stream so the reveal controller doesn't keep rendering with stale values.
	 */
	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#proseOnlyThinking = this.#getProseOnlyThinking();
		// Recalculate visible units — hiding thinking blocks may reduce the total,
		// and the reveal position may now exceed it.
		const total = this.#visibleUnits(this.#target);
		this.#revealed = Math.min(this.#revealed, total);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	/** Total reveal units of `message`, memoized per block across ticks. */
	#visibleUnits(message: AssistantMessage): number {
		let total = 0;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i]!;
			if (block.type === "text") {
				total += this.#unitCounter.count(i, block.text);
			} else if (block.type === "thinking" && !this.#hideThinkingBlock) {
				const formatted = formatThinkingForDisplay(block.thinking, this.#proseOnlyThinking);
				if (hasDisplayableThinking(block.thinking, formatted)) {
					total += this.#unitCounter.count(i, formatted);
				}
			}
		}
		return total;
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		// Every controller render is an in-flight streaming snapshot, even when
		// smooth reveal has temporarily caught up to the current target. The
		// message_end handler performs the only stable non-transient render.
		this.#component.updateContent(
			buildDisplayMessage(
				this.#target,
				this.#revealed,
				this.#hideThinkingBlock,
				this.#proseOnlyThinking,
				this.#countOf,
				this.#sliceOf,
			),
			{ transient: true },
		);
	}

	#syncTimer(total = this.#target ? this.#visibleUnits(this.#target) : 0): void {
		if (!this.#target || !this.#component || this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) {
			this.stop();
			return;
		}
		const total = this.#visibleUnits(target);
		if (this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#revealed = Math.min(total, this.#revealed + nextStep(total - this.#revealed));
		component.updateContent(
			buildDisplayMessage(
				target,
				this.#revealed,
				this.#hideThinkingBlock,
				this.#proseOnlyThinking,
				this.#countOf,
				this.#sliceOf,
			),
			{
				transient: true,
			},
		);
		this.#requestRender();
		if (this.#revealed >= total) {
			this.#stopTimer();
		}
	}
}
