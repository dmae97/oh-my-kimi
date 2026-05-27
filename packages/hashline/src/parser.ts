/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 *
 * Lifecycle:
 *
 * 1. Construct one {@link Executor} per hunk (or share one with `reset()`).
 * 2. Feed it tokens via {@link Executor.feed}. Multi-line payloads are
 *    accumulated across tokens until the next op flushes them.
 * 3. Call {@link Executor.end} to flush the trailing pending op and validate
 *    cross-op invariants (no overlapping deletes, etc.).
 *
 * Convenience entry point: {@link parsePatch}.
 */
import { HL_OP_CHARS, HL_OP_INSERT_AFTER, HL_OP_INSERT_BEFORE, HL_OP_REPLACE, HL_PAYLOAD_PREFIX } from "./format";
import {
	ABORT_WARNING,
	IMPLICIT_CONTINUATION_WARNING,
	INLINE_PAYLOAD_ACCEPTED_WARNING,
	PAYLOAD_LINE_PREFIX_DEMOTED_WARNING,
	REPLACE_PAIR_COALESCED_WARNING,
} from "./messages";
import { cloneCursor, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, Cursor, Edit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}-${range.end.line} ends before it starts.`);
	}
}

function rangesEqual(a: ParsedRange, b: ParsedRange): boolean {
	return a.start.line === b.start.line && a.end.line === b.end.line;
}

function rangeContains(outer: ParsedRange, inner: ParsedRange): boolean {
	return outer.start.line <= inner.start.line && inner.end.line <= outer.end.line;
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

interface PendingComment {
	lineNum: number;
	text: string;
}

type PendingOp =
	| { kind: "insert"; cursor: Cursor; lineNum: number }
	| { kind: "replace"; range: ParsedRange; lineNum: number };

interface Pending {
	op: PendingOp;
	payload: string[];
}

/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s.
 *
 * `feed()` accepts tokens one at a time; multi-line payloads accumulate
 * until the next op or {@link end} flushes them. After `terminated` flips
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
				this.#handlePayload(token.text, token.lineNum);
				return;
			case "raw":
				if (this.#pending === undefined && isSkippableCommentLine(token.text)) {
					this.#skippableComments.push({ text: token.text, lineNum: token.lineNum });
					return;
				}
				this.#consumePendingSkippableComments();
				this.#handleRaw(token.text, token.lineNum);
				return;
			case "op-insert":
				this.#discardPendingSkippableComments();
				this.#flushPending();
				this.#pending = {
					op: { kind: "insert", cursor: token.cursor, lineNum: token.lineNum },
					payload: [],
				};
				if (token.inlineBody !== undefined) {
					this.#pending.payload.push(token.inlineBody);
					if (!this.#warnings.includes(INLINE_PAYLOAD_ACCEPTED_WARNING)) {
						this.#warnings.push(INLINE_PAYLOAD_ACCEPTED_WARNING);
					}
				}
				return;
			case "op-replace":
				this.#discardPendingSkippableComments();
				validateRangeOrder(token.range, token.lineNum);
				if (this.#pending !== undefined && this.#pending.op.kind === "replace") {
					const outer = this.#pending.op.range;
					const inner = token.range;
					if (rangesEqual(outer, inner)) {
						// Identical-range before/after pair. Drop the "before" payload
						// silently; the second op proceeds as the lone winner. Other
						// overlap shapes (different ranges) still hit the post-hoc
						// validator.
						this.#pending = undefined;
						if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_WARNING)) {
							this.#warnings.push(REPLACE_PAIR_COALESCED_WARNING);
						}
					} else if (rangeContains(outer, inner)) {
						// Model wrote a payload line in read-output `LINE:TEXT` format
						// (or `A-B:TEXT` for a sub-range) inside an outer `A-B:` block.
						// The tokenizer can't tell payload from op when the anchor and
						// sigil shape are identical, so demote: append the op's inline
						// body to the pending payload, strip the `LINE:` prefix, and
						// keep accumulating. Without this the inner anchors would each
						// register as their own delete and clash with the outer range.
						this.#pending.payload.push(token.inlineBody ?? "");
						if (!this.#warnings.includes(PAYLOAD_LINE_PREFIX_DEMOTED_WARNING)) {
							this.#warnings.push(PAYLOAD_LINE_PREFIX_DEMOTED_WARNING);
						}
						return;
					}
				}
				this.#flushPending();
				this.#pending = {
					op: { kind: "replace", range: token.range, lineNum: token.lineNum },
					payload: [],
				};
				if (token.inlineBody !== undefined) {
					this.#pending.payload.push(token.inlineBody);
					if (!this.#warnings.includes(INLINE_PAYLOAD_ACCEPTED_WARNING)) {
						this.#warnings.push(INLINE_PAYLOAD_ACCEPTED_WARNING);
					}
				}
				return;
		}
	}

	/**
	 * Flush any open pending op (with its full accumulated payload, including
	 * explicit `+` blank lines) and return the accumulated edits and
	 * warnings. The executor is single-use; {@link reset} is required for
	 * reuse.
	 *
	 * Throws if two replace ops target the same line with non-identical
	 * ranges. Identical-range `A-B:` pairs in the same hunk are coalesced
	 * last-wins by `feed()` with a warning, so they never reach the
	 * validator.
	 */
	end(): { edits: Edit[]; warnings: string[] } {
		this.#consumePendingSkippableComments();
		this.#flushPending();
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
	 * Each `:` op contributes a delete edit per line in its range; if any
	 * line ends up targeted by deletes originating from two different source
	 * ops (distinguished by their `lineNum`), the patch is internally
	 * inconsistent. Identical-range `A-B:` pairs are already collapsed by
	 * `feed()`; remaining shapes here are an `A-B:` that overlaps a later
	 * `N:` with a different range. The applier would run both literally and
	 * the file would end up with two copies of the line, not a chosen
	 * winner.
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
			const [firstOp, secondOp] = [...sourceLines].sort((a, b) => a - b);
			throw new Error(
				`line ${secondOp}: anchor line ${anchorLine} is already targeted by the ${HL_OP_REPLACE} op on line ${firstOp}. ` +
					`Issue ONE op per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
	}

	#handlePayload(text: string, lineNum: number): void {
		if (this.#pending) {
			this.#pending.payload.push(text);
			return;
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding ${HL_OP_INSERT_BEFORE}, ${HL_OP_INSERT_AFTER}, or ${HL_OP_REPLACE} operation. ` +
				`Got ${JSON.stringify(`${HL_PAYLOAD_PREFIX}${text}`)}.`,
		);
	}

	#handleRaw(text: string, lineNum: number): void {
		if (this.#pending) {
			if (text.trim().length === 0) return;
			// Lenient legacy fallback: the tokenizer routes a line to `raw` only
			// when it does not parse as an op, header, payload, or envelope
			// marker. A `raw` token while a pending op exists is therefore an
			// unambiguous continuation row that the author wrote without the
			// `+` prefix. Accept it as payload and warn so the canonical
			// `+`-prefixed form remains preferred.
			this.#pending.payload.push(text);
			if (!this.#warnings.includes(IMPLICIT_CONTINUATION_WARNING)) {
				this.#warnings.push(IMPLICIT_CONTINUATION_WARNING);
			}
			return;
		}

		// Whitespace-only raw lines outside any pending op are silently dropped;
		// fully empty lines arrive as `blank` tokens.
		if (text.trim().length === 0) return;

		const firstChar = text[0];
		const startsWithOp = firstChar !== undefined && HL_OP_CHARS.includes(firstChar);
		if (startsWithOp || firstChar === "-" || firstChar === "@" || firstChar === "«" || firstChar === "»") {
			throw new Error(
				`line ${lineNum}: unrecognized op. Use LINE${HL_OP_INSERT_BEFORE} (insert before), LINE${HL_OP_INSERT_AFTER} (insert after), or LINE${HL_OP_REPLACE} / A-B${HL_OP_REPLACE} (replace). ` +
					`Got ${JSON.stringify(text)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding ${HL_OP_INSERT_BEFORE}, ${HL_OP_INSERT_AFTER}, or ${HL_OP_REPLACE} operation. ` +
				`Got ${JSON.stringify(text)}.`,
		);
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending) return;

		const { op, payload } = pending;
		const linesToInsert = payload.length === 0 ? [""] : payload;

		if (op.kind === "insert") {
			for (const text of linesToInsert) {
				this.#edits.push({
					kind: "insert",
					cursor: cloneCursor(op.cursor),
					text,
					lineNum: op.lineNum,
					index: this.#editIndex++,
				});
			}
		} else {
			for (const text of linesToInsert) {
				this.#edits.push({
					kind: "insert",
					cursor: { kind: "before_anchor", anchor: { ...op.range.start } },
					text,
					lineNum: op.lineNum,
					index: this.#editIndex++,
				});
			}
			for (const anchor of expandRange(op.range)) {
				this.#edits.push({ kind: "delete", anchor, lineNum: op.lineNum, index: this.#editIndex++ });
			}
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
