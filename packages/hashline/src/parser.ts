/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 *
 * Lifecycle:
 *
 * 1. Construct one {@link Executor} per hunk (or share one with `reset()`).
 * 2. Feed it tokens via {@link Executor.feed}. Block payload rows are
 *    accumulated across tokens until the next anchor block flushes them.
 * 3. Call {@link Executor.end} to flush the trailing pending block and validate
 *    cross-block invariants (no overlapping deletes, etc.).
 *
 * Convenience entry point: {@link parsePatch}.
 */
import { HL_OP_REPLACE, HL_PAYLOAD_ABOVE, HL_PAYLOAD_BELOW, HL_PAYLOAD_REPLACE } from "./format";
import {
	ABORT_WARNING,
	INLINE_PAYLOAD_REJECTED_PREFIX,
	REPLACE_PAIR_COALESCED_WARNING,
	VIRTUAL_REPLACE_REJECTED_MESSAGE,
} from "./messages";
import {
	type BlockTarget,
	cloneCursor,
	type ParsedRange,
	type PayloadBucket,
	type Token,
	Tokenizer,
} from "./tokenizer";
import type { Anchor, Cursor, Edit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}-${range.end.line} ends before it starts.`);
	}
}

function rangesEqual(a: ParsedRange, b: ParsedRange): boolean {
	return a.start.line === b.start.line && a.end.line === b.end.line;
}

function targetsEqualConcreteRange(a: BlockTarget, b: BlockTarget): boolean {
	return a.kind === "range" && b.kind === "range" && rangesEqual(a.range, b.range);
}

function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) {
		anchors.push({ line });
	}
	return anchors;
}

function isSkippableCommentLine(line: string): boolean {
	return line.trimStart().startsWith("#");
}

function sigilForBucket(bucket: PayloadBucket): string {
	if (bucket === "above") return HL_PAYLOAD_ABOVE;
	if (bucket === "below") return HL_PAYLOAD_BELOW;
	return HL_PAYLOAD_REPLACE;
}

function describeTarget(target: BlockTarget): string {
	if (target.kind === "bof") return "BOF:";
	if (target.kind === "eof") return "EOF:";
	const { start, end } = target.range;
	return start.line === end.line ? `${start.line}:` : `${start.line}-${end.line}:`;
}

interface PendingComment {
	lineNum: number;
	text: string;
}

interface PayloadRow {
	bucket: PayloadBucket;
	text: string;
	lineNum: number;
}

interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
}

/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s.
 *
 * `feed()` accepts tokens one at a time; block payload rows accumulate until
 * the next anchor block or {@link end} flushes them. After `terminated` flips
 * true (on `envelope-end` or `abort`) subsequent feeds are silently ignored
 * so callers can keep draining their tokenizer.
 */
export class Executor {
	#edits: Edit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#terminated = false;
	#skippableComments: PendingComment[] = [];

	#discardPendingSkippableComments(): void {
		this.#skippableComments = [];
	}

	#consumePendingSkippableComments(): void {
		if (this.#skippableComments.length === 0) return;
		const comment = this.#skippableComments[0];
		this.#skippableComments = [];
		this.#handleRaw(comment.text, comment.lineNum);
	}

	/** True once an `envelope-end` or `abort` token has been observed. */
	get terminated(): boolean {
		return this.#terminated;
	}

	/**
	 * Consume one token. After `terminated` flips true subsequent feeds are
	 * silently ignored so callers can keep draining the tokenizer without
	 * explicit early-exit guards.
	 */
	feed(token: Token): void {
		if (this.#terminated) return;

		switch (token.kind) {
			case "envelope-begin":
				this.#consumePendingSkippableComments();
				return;
			case "envelope-end":
				this.#consumePendingSkippableComments();
				this.#terminated = true;
				return;
			case "abort":
				this.#warnings.push(ABORT_WARNING);
				this.#terminated = true;
				return;
			case "header":
				this.#consumePendingSkippableComments();
				this.#flushPending();
				return;
			case "blank":
				this.#consumePendingSkippableComments();
				return;
			case "payload":
				this.#consumePendingSkippableComments();
				this.#handlePayload(token.bucket, token.text, token.lineNum);
				return;
			case "raw":
				if (this.#pending === undefined && isSkippableCommentLine(token.text)) {
					this.#skippableComments.push({ text: token.text, lineNum: token.lineNum });
					return;
				}
				this.#consumePendingSkippableComments();
				this.#handleRaw(token.text, token.lineNum);
				return;
			case "op-block":
				this.#discardPendingSkippableComments();
				if (token.inlineBody !== undefined) {
					throw new Error(
						`line ${token.lineNum}: ${INLINE_PAYLOAD_REJECTED_PREFIX} ` +
							`Use a bare anchor line such as ${describeTarget(token.target)}, then put payload on following rows prefixed with ` +
							`${HL_PAYLOAD_REPLACE}, ${HL_PAYLOAD_ABOVE}, or ${HL_PAYLOAD_BELOW}.`,
					);
				}
				if (token.target.kind === "range") validateRangeOrder(token.target.range, token.lineNum);
				if (this.#pending !== undefined && targetsEqualConcreteRange(this.#pending.target, token.target)) {
					this.#pending = undefined;
					if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_WARNING)) {
						this.#warnings.push(REPLACE_PAIR_COALESCED_WARNING);
					}
				} else {
					this.#flushPending();
				}
				this.#pending = { target: token.target, lineNum: token.lineNum, payloads: [] };
				return;
		}
	}

	/**
	 * Flush any open pending block and return the accumulated edits and
	 * warnings. The executor is single-use; {@link reset} is required for reuse.
	 *
	 * Throws if two replacement/delete blocks target the same line with
	 * non-identical ranges. Identical-range blocks in the same hunk are
	 * coalesced last-wins by `feed()` with a warning, so they never reach the
	 * validator.
	 */
	end(): { edits: Edit[]; warnings: string[] } {
		this.#consumePendingSkippableComments();
		this.#flushPending();
		this.#validateNoOverlappingDeletes();
		return { edits: this.#edits, warnings: this.#warnings };
	}

	/**
	 * Streaming-tolerant variant of {@link end}. Identical, except a pending
	 * block whose payload has not yet accumulated any rows is treated as still
	 * in flight and dropped instead of flushed (which would otherwise preview a
	 * destructive bare delete while the model may still be typing payload).
	 */
	endStreaming(): { edits: Edit[]; warnings: string[] } {
		this.#consumePendingSkippableComments();
		if (this.#pending && this.#pending.payloads.length > 0) {
			this.#flushPending();
		} else {
			this.#pending = undefined;
		}
		this.#validateNoOverlappingDeletes();
		return { edits: this.#edits, warnings: this.#warnings };
	}

	/** Reset to a fresh state so the same instance can drive another parse. */
	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#skippableComments = [];
		this.#terminated = false;
	}

	/**
	 * Each replacement/delete block contributes a delete edit per line in its
	 * range; if any line ends up targeted by deletes originating from two
	 * different source blocks (distinguished by their `lineNum`), the patch is
	 * internally inconsistent.
	 */
	#validateNoOverlappingDeletes(): void {
		const sourceLinesByAnchor = new Map<number, number[]>();
		for (const edit of this.#edits) {
			if (edit.kind !== "delete") continue;
			let sourceLines = sourceLinesByAnchor.get(edit.anchor.line);
			if (sourceLines === undefined) {
				sourceLines = [];
				sourceLinesByAnchor.set(edit.anchor.line, sourceLines);
			}
			if (!sourceLines.includes(edit.lineNum)) sourceLines.push(edit.lineNum);
		}
		for (const [anchorLine, sourceLines] of sourceLinesByAnchor) {
			if (sourceLines.length < 2) continue;
			const [firstBlock, secondBlock] = [...sourceLines].sort((a, b) => a - b);
			throw new Error(
				`line ${secondBlock}: anchor line ${anchorLine} is already targeted by the ${HL_OP_REPLACE} block on line ${firstBlock}. ` +
					`Issue ONE block per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
	}

	#handlePayload(bucket: PayloadBucket, text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			throw new Error(
				`line ${lineNum}: payload line has no preceding A-B:, A:, BOF:, or EOF: anchor. ` +
					`Got ${JSON.stringify(`${sigilForBucket(bucket)}${text}`)}.`,
			);
		}
		if (bucket === "replace" && pending.target.kind !== "range") {
			throw new Error(`line ${lineNum}: ${VIRTUAL_REPLACE_REJECTED_MESSAGE}`);
		}
		pending.payloads.push({ bucket, text, lineNum });
	}

	#handleRaw(text: string, lineNum: number): void {
		if (this.#pending) {
			if (text.trim().length === 0) return;
			throw new Error(
				`line ${lineNum}: payload row in a hashline block must start with ` +
					`${HL_PAYLOAD_REPLACE}, ${HL_PAYLOAD_ABOVE}, or ${HL_PAYLOAD_BELOW}. Got ${JSON.stringify(text)}.`,
			);
		}

		// Whitespace-only raw lines outside any pending block are silently dropped;
		// fully empty lines arrive as `blank` tokens.
		if (text.trim().length === 0) return;

		const firstChar = text[0];
		if (firstChar === "-" || firstChar === "@" || firstChar === "«" || firstChar === "»") {
			throw new Error(
				`line ${lineNum}: unrecognized hashline block. Use A-B:, A:, BOF:, or EOF: anchors followed by ` +
					`${HL_PAYLOAD_REPLACE}, ${HL_PAYLOAD_ABOVE}, or ${HL_PAYLOAD_BELOW} payload rows. Got ${JSON.stringify(text)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding A-B:, A:, BOF:, or EOF: anchor. Got ${JSON.stringify(text)}.`,
		);
	}

	#pushInsert(cursor: Cursor, text: string, lineNum: number, mode?: "replacement"): void {
		this.#edits.push({
			kind: "insert",
			cursor: cloneCursor(cursor),
			text,
			lineNum,
			index: this.#editIndex++,
			...(mode === undefined ? {} : { mode }),
		});
	}

	#pushDelete(anchor: Anchor, lineNum: number): void {
		this.#edits.push({ kind: "delete", anchor: { ...anchor }, lineNum, index: this.#editIndex++ });
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending) return;

		const { target, lineNum, payloads } = pending;
		if (target.kind === "bof" || target.kind === "eof") {
			const cursor: Cursor = target.kind === "bof" ? { kind: "bof" } : { kind: "eof" };
			for (const payload of payloads) {
				this.#pushInsert(cursor, payload.text, lineNum);
			}
			this.#pending = undefined;
			return;
		}

		const above: string[] = [];
		const replacement: string[] = [];
		const below: string[] = [];
		for (const payload of payloads) {
			if (payload.bucket === "above") above.push(payload.text);
			else if (payload.bucket === "below") below.push(payload.text);
			else replacement.push(payload.text);
		}

		for (const text of above) {
			this.#pushInsert({ kind: "before_anchor", anchor: { ...target.range.start } }, text, lineNum);
		}

		if (replacement.length > 0) {
			for (const text of replacement) {
				this.#pushInsert(
					{ kind: "before_anchor", anchor: { ...target.range.start } },
					text,
					lineNum,
					"replacement",
				);
			}
			for (const anchor of expandRange(target.range)) {
				this.#pushDelete(anchor, lineNum);
			}
		} else if (above.length === 0 && below.length === 0) {
			for (const anchor of expandRange(target.range)) {
				this.#pushDelete(anchor, lineNum);
			}
		}

		for (const text of below) {
			this.#pushInsert({ kind: "after_anchor", anchor: { ...target.range.end } }, text, lineNum);
		}

		this.#pending = undefined;
	}
}

/**
 * Drive a full hashline diff through the tokenizer + executor pipeline and
 * return the resulting edits plus any parse-time warnings. This is the
 * convenience entry point most callers want; reach for {@link Tokenizer} /
 * {@link Executor} directly only when you need streaming feeds, cross-section
 * state, or custom token handling.
 */
export function parsePatch(diff: string): { edits: Edit[]; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	const drain = (tokens: Token[]): void => {
		for (const token of tokens) {
			if (executor.terminated) return;
			executor.feed(token);
		}
	};
	drain(tokenizer.feed(diff));
	drain(tokenizer.end());
	return executor.end();
}

/**
 * Streaming-tolerant variant of {@link parsePatch}. Returns whatever edits
 * parsed successfully when the diff is still being typed:
 *
 * - per-token feed errors stop the drain but preserve the edits already
 *   collected (the trailing block is malformed mid-stream — wait for the next
 *   chunk),
 * - the trailing pending block is dropped if it has no payload yet (avoids a
 *   destructive bare-delete preview while payload may still be coming).
 *
 * Throws only on the cross-block overlap validator, which catches conflicting
 * shapes (two replacements/deletes hitting the same anchor). Streaming preview
 * callers should treat any throw here as "no preview this tick".
 */
export function parsePatchStreaming(diff: string): { edits: Edit[]; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	const drain = (tokens: Token[]): boolean => {
		for (const token of tokens) {
			if (executor.terminated) return false;
			try {
				executor.feed(token);
			} catch {
				return true; // stop on first parse error; keep what's collected
			}
		}
		return false;
	};
	if (drain(tokenizer.feed(diff))) return executor.endStreaming();
	drain(tokenizer.end());
	return executor.endStreaming();
}
