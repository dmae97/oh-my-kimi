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
import { HL_PAYLOAD_REPEAT, HL_PAYLOAD_REPLACE } from "./format";
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	DASH_PAYLOAD_AUTO_DELETE_WARNING,
	INLINE_PAYLOAD_REJECTED_PREFIX,
	PLUS_PREFIXED_REPEAT_WARNING,
	REPLACE_PAIR_COALESCED_OVERLAP_WARNING,
	REPLACE_PAIR_COALESCED_WARNING,
	STACKED_BLANK_REPLACE_WARNING,
	VIRTUAL_REPLACE_REJECTED_MESSAGE,
} from "./messages";
import { type BlockTarget, cloneCursor, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, Cursor, Edit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}-${range.end.line} ends before it starts.`);
	}
}

/**
 * If `text` (the slice after a `+` literal sigil) trims to `^A-B` (or `^A`,
 * accepted as `^A-A`), return the parsed range. Otherwise `null`. Used to
 * silently reroute `+^A-B` rows as repeats — models reflexively prefix every
 * body row with `+`, including ones that should be repeats.
 */
function tryParseLiteralAsRepeat(text: string): ParsedRange | null {
	const stripped = text.trim();
	if (stripped.length === 0 || stripped.charCodeAt(0) !== 94 /* ^ */) return null;
	const match = /^\^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(stripped);
	if (match === null) return null;
	const start = Number.parseInt(match[1], 10);
	const end = match[2] !== undefined ? Number.parseInt(match[2], 10) : start;
	return { start: { line: start }, end: { line: end } };
}

function rangesEqual(a: ParsedRange, b: ParsedRange): boolean {
	return a.start.line === b.start.line && a.end.line === b.end.line;
}

function targetsEqualConcreteRange(a: BlockTarget, b: BlockTarget): boolean {
	return a.kind === "range" && b.kind === "range" && rangesEqual(a.range, b.range);
}

function rangesOverlap(a: ParsedRange, b: ParsedRange): boolean {
	return a.start.line <= b.end.line && b.start.line <= a.end.line;
}

function rangesOverlapBetweenTargets(a: BlockTarget, b: BlockTarget): boolean {
	return a.kind === "range" && b.kind === "range" && rangesOverlap(a.range, b.range);
}

/**
 * Detect OpenAI-`apply_patch` / unified-diff contamination in a raw line.
 * Returns the error message to throw, or `null` when the line is clean.
 *
 * We only catch shapes that are unambiguously NOT hashline:
 * - `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` sentinels
 * - unified-diff hunk headers (`@@`, `@@ -1,3 +1,3 @@`)
 * - apply_patch hunk-anchor prefixes `-N:` / `-N-M:` — the bare `-N` form
 *   (no `:` and no `-M`) is intentionally NOT matched so the existing strict
 *   "unrecognized hashline block" diagnostic still fires on the legacy
 *   delete-row shape `-5`.
 *
 * `+`-prefixed shapes are NOT detected here because `+` is hashline's
 * literal payload sigil; `+TEXT` / `+N:` are valid payload rows (or, at
 * top level, orphan payloads that fall through to the standard "no
 * preceding A-B:" error).
 */
function detectApplyPatchContamination(text: string, _hasPending: boolean): string | null {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return null;

	if (
		trimmed.startsWith("*** Update File:") ||
		trimmed.startsWith("*** Add File:") ||
		trimmed.startsWith("*** Delete File:") ||
		trimmed.startsWith("*** Move to:")
	) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. ` +
			`Use \`${"\u00b6"}PATH#HASH\` then \`A-B:\` / \`A-B:-\` / \`BOF:\` / \`EOF:\` blocks; do not wrap edits in another format's envelope.`
		);
	}
	if (trimmed === "@@" || trimmed.startsWith("@@ ") || trimmed.startsWith("@@\t")) {
		return (
			"unified-diff hunk header (`@@`) is not valid in hashline. " +
			"Use a `¶PATH#HASH` header and bare `A-B:` anchor blocks."
		);
	}
	if (/^-\d+(-\d+)?:/.test(trimmed)) {
		return (
			"apply_patch line prefix (`-N:` / `-N-M:`) is not valid in hashline. " +
			"Drop the `-` prefix; use `A-B:` (replace) or `A-B:-` (delete) on the anchor line itself."
		);
	}
	return null;
}

function pendingHasAnyContent(pending: Pending): boolean {
	return pending.payloads.length > 0 || pending.pendingRaws.length > 0;
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

function describeTarget(target: BlockTarget): string {
	if (target.kind === "bof") return "BOF:";
	if (target.kind === "eof") return "EOF:";
	const { start, end } = target.range;
	return `${start.line}-${end.line}:`;
}

interface PendingComment {
	lineNum: number;
	text: string;
}

type PayloadRow =
	| { kind: "literal"; text: string; lineNum: number }
	| { kind: "repeat"; range: ParsedRange; lineNum: number };

interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
	/**
	 * Bare body rows (no `|`/`^` prefix) buffered while we wait to see
	 * whether the entire block is uniformly unprefixed. On flush, if every
	 * row was bare AND no `|`/`^` row was ever observed for this block, we
	 * auto-pipe the buffered rows and emit a {@link BARE_BODY_AUTO_PIPED_WARNING}.
	 */
	pendingRaws: { text: string; lineNum: number }[];
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
	/**
	 * Length of the current run of consecutive single-line empty-body
	 * replacements (`A-A:` with no payload). Reset on every non-matching
	 * flush; surfaces {@link STACKED_BLANK_REPLACE_WARNING} when the run
	 * reaches two.
	 */
	#blankSingleRun = 0;

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
				this.#terminated = true;
				return;
			case "header":
				this.#consumePendingSkippableComments();
				this.#flushPending();
				return;
			case "blank":
				this.#consumePendingSkippableComments();
				return;
			case "payload-literal":
				this.#consumePendingSkippableComments();
				this.#handleLiteralPayload(token.text, token.lineNum);
				return;
			case "payload-repeat":
				this.#consumePendingSkippableComments();
				this.#handleRepeatPayload(token.range, token.lineNum);
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
				if (token.deleteSuffix) {
					if (token.target.kind !== "range") {
						throw new Error(`line ${token.lineNum}: ${VIRTUAL_REPLACE_REJECTED_MESSAGE}`);
					}
					validateRangeOrder(token.target.range, token.lineNum);
					// L5 (delete-suffix variant): if pending is a bare anchor that
					// overlaps the new delete range, drop it silently — the model
					// expressed `A-B:` then `A-B:-` (the classic before-then-after
					// shape) and the actual intent is "delete A-B".
					if (
						this.#pending !== undefined &&
						!pendingHasAnyContent(this.#pending) &&
						rangesOverlapBetweenTargets(this.#pending.target, token.target)
					) {
						this.#pending = undefined;
						this.#blankSingleRun = 0;
						if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_OVERLAP_WARNING)) {
							this.#warnings.push(REPLACE_PAIR_COALESCED_OVERLAP_WARNING);
						}
					} else {
						this.#flushPending();
					}
					for (const anchor of expandRange(token.target.range)) {
						this.#pushDelete(anchor, token.lineNum);
					}
					this.#blankSingleRun = 0;
					return;
				}
				if (token.inlineBody !== undefined) {
					throw new Error(
						`line ${token.lineNum}: ${INLINE_PAYLOAD_REJECTED_PREFIX} ` +
							`Write the anchor on its own line (e.g. ${describeTarget(token.target)}), then put the body content on the next line prefixed with ` +
							`${HL_PAYLOAD_REPLACE} (literal) or ${HL_PAYLOAD_REPEAT}A-B (repeat). If you pasted "${describeTarget(token.target).slice(0, -1)}CONTENT" from \`read\` output, strip the leading "${describeTarget(token.target).slice(0, -1)}" and prefix the rest with ${HL_PAYLOAD_REPLACE}.`,
					);
				}
				if (token.target.kind === "range") validateRangeOrder(token.target.range, token.lineNum);
				if (this.#pending !== undefined && targetsEqualConcreteRange(this.#pending.target, token.target)) {
					// Identical-range coalesce: drop the first block. Last-wins.
					this.#pending = undefined;
					if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_WARNING)) {
						this.#warnings.push(REPLACE_PAIR_COALESCED_WARNING);
					}
				} else if (
					this.#pending !== undefined &&
					!pendingHasAnyContent(this.#pending) &&
					rangesOverlapBetweenTargets(this.#pending.target, token.target)
				) {
					// L5 (replace variant): bare pending block overlaps the new
					// concrete block; treat as before/after pair, drop the bare
					// one. The new block becomes pending.
					this.#pending = undefined;
					if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_OVERLAP_WARNING)) {
						this.#warnings.push(REPLACE_PAIR_COALESCED_OVERLAP_WARNING);
					}
				} else {
					this.#flushPending();
				}
				this.#pending = { target: token.target, lineNum: token.lineNum, payloads: [], pendingRaws: [] };
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
		if (this.#pending && pendingHasAnyContent(this.#pending)) {
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
		this.#blankSingleRun = 0;
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
				`line ${secondBlock}: anchor line ${anchorLine} is already targeted by another op on line ${firstBlock}. ` +
					`Issue ONE block per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
	}

	#handleLiteralPayload(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			throw new Error(
				`line ${lineNum}: payload line has no preceding A-B:, BOF:, or EOF: anchor. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPLACE}${text}`)}.`,
			);
		}
		// Silent recovery: a body row of `+^A-B` (or `+^A` after L2 shorthand)
		// is a repeat row the model mistakenly prefixed with `+`. Reroute as
		// a repeat and surface a warning so the model sees the mistake.
		const repeatRange = tryParseLiteralAsRepeat(text);
		if (repeatRange !== null) {
			if (!this.#warnings.includes(PLUS_PREFIXED_REPEAT_WARNING)) {
				this.#warnings.push(PLUS_PREFIXED_REPEAT_WARNING);
			}
			this.#handleRepeatPayload(repeatRange, lineNum);
			return;
		}
		// L3: a `+literal` row after buffered bare raws means the block is
		// NOT uniformly unprefixed — the bare rows were typos. Reject at the
		// FIRST bare row's source line so the message points the model at
		// what to fix.
		this.#rejectBufferedRawsOnMixedBlock(pending);
		pending.payloads.push({ kind: "literal", text, lineNum });
	}

	#handleRepeatPayload(range: ParsedRange, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			throw new Error(
				`line ${lineNum}: payload line has no preceding A-B:, BOF:, or EOF: anchor. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPEAT}${range.start.line}-${range.end.line}`)}.`,
			);
		}
		// L3: same mixed-block guard as the literal path — see above.
		this.#rejectBufferedRawsOnMixedBlock(pending);
		validateRangeOrder(range, lineNum);
		pending.payloads.push({ kind: "repeat", range, lineNum });
	}

	#rejectBufferedRawsOnMixedBlock(pending: Pending): void {
		if (pending.pendingRaws.length === 0) return;
		const first = pending.pendingRaws[0];
		throw new Error(
			`line ${first.lineNum}: payload row in a hashline block must start with ` +
				`${HL_PAYLOAD_REPLACE} or ${HL_PAYLOAD_REPEAT}A-B. Got ${JSON.stringify(first.text)}.`,
		);
	}

	#handleRaw(text: string, lineNum: number): void {
		// L8: detect OpenAI-apply_patch / unified-diff contamination first so
		// the error message tells the model what format they shipped instead
		// of the generic "payload row must start with …" diagnostic.
		const contamination = detectApplyPatchContamination(text, this.#pending !== undefined);
		if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`);

		if (this.#pending) {
			if (text.trim().length === 0) return;

			// L4: a lone `-` row inside a bare pending block is the classic
			// "I meant `A-B:-` but typed it on the next line" shape. Convert
			// retroactively, emit a warning, and clear pending.
			if (
				text.trim() === "-" &&
				this.#pending.payloads.length === 0 &&
				this.#pending.pendingRaws.length === 0 &&
				this.#pending.target.kind === "range"
			) {
				const pendingRange = this.#pending.target.range;
				const sourceLine = this.#pending.lineNum;
				validateRangeOrder(pendingRange, sourceLine);
				for (const anchor of expandRange(pendingRange)) {
					this.#pushDelete(anchor, sourceLine);
				}
				if (!this.#warnings.includes(DASH_PAYLOAD_AUTO_DELETE_WARNING)) {
					this.#warnings.push(DASH_PAYLOAD_AUTO_DELETE_WARNING);
				}
				this.#pending = undefined;
				this.#blankSingleRun = 0;
				return;
			}

			// L3: buffer the bare row. Mixing this with later `|`/`^` rows
			// throws via `#rejectBufferedRawsOnMixedBlock`; reject IMMEDIATELY
			// when the block already has `|`/`^` rows so the error points at
			// the offending bare row, not the (innocent) first `|` row.
			if (this.#pending.payloads.length > 0) {
				throw new Error(
					`line ${lineNum}: payload row in a hashline block must start with ` +
						`${HL_PAYLOAD_REPLACE} or ${HL_PAYLOAD_REPEAT}A-B. Got ${JSON.stringify(text)}.`,
				);
			}
			this.#pending.pendingRaws.push({ text, lineNum });
			return;
		}

		// Whitespace-only raw lines outside any pending block are silently dropped;
		// fully empty lines arrive as `blank` tokens.
		if (text.trim().length === 0) return;

		const firstChar = text[0];
		if (firstChar === "-" || firstChar === "@" || firstChar === "«" || firstChar === "»") {
			if (text.trim() === "-") {
				throw new Error(
					`line ${lineNum}: a lone "-" is not a valid hashline op. To delete a range, write \`A-B:-\` on the anchor line itself (e.g. \`5-7:-\`).`,
				);
			}
			throw new Error(
				`line ${lineNum}: unrecognized hashline block. Use A-B:, A-B:-, BOF:, or EOF: anchors followed by ` +
					`${HL_PAYLOAD_REPLACE}TEXT or ${HL_PAYLOAD_REPEAT}A-B body rows. Got ${JSON.stringify(text)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding A-B:, BOF:, or EOF: anchor. Got ${JSON.stringify(text)}.`,
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

	#pushRepeat(cursor: Cursor, range: ParsedRange, lineNum: number, mode?: "replacement"): void {
		this.#edits.push({
			kind: "repeat",
			cursor: cloneCursor(cursor),
			range: { start: { ...range.start }, end: { ...range.end } },
			lineNum,
			index: this.#editIndex++,
			...(mode === undefined ? {} : { mode }),
		});
	}

	#pushDelete(anchor: Anchor, lineNum: number): void {
		this.#edits.push({ kind: "delete", anchor: { ...anchor }, lineNum, index: this.#editIndex++ });
	}

	#emitPayloadRow(cursor: Cursor, payload: PayloadRow, lineNum: number, mode?: "replacement"): void {
		if (payload.kind === "literal") {
			this.#pushInsert(cursor, payload.text, lineNum, mode);
			return;
		}
		this.#pushRepeat(cursor, payload.range, lineNum, mode);
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending) return;

		// L3: convert any buffered bare body rows to literal payloads. Mixed
		// blocks have already been rejected; we only get here when payloads
		// is empty AND pendingRaws holds rows, or when both are empty.
		const hadBareBody = pending.pendingRaws.length > 0;
		if (hadBareBody) {
			for (const raw of pending.pendingRaws) {
				pending.payloads.push({ kind: "literal", text: raw.text, lineNum: raw.lineNum });
			}
			pending.pendingRaws = [];
			if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) {
				this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
			}
		}

		const { target, lineNum, payloads } = pending;
		if (target.kind === "bof" || target.kind === "eof") {
			const cursor: Cursor = target.kind === "bof" ? { kind: "bof" } : { kind: "eof" };
			if (payloads.length === 0) {
				this.#pushInsert(cursor, "", lineNum);
			} else {
				for (const payload of payloads) {
					this.#emitPayloadRow(cursor, payload, lineNum);
				}
			}
			this.#pending = undefined;
			this.#blankSingleRun = 0;
			return;
		}

		// L7 was considered (`^A-B` covering target + literal payload) but
		// dropped: the same shape is the canonical "keep line A unchanged,
		// insert new content above/below" idiom (e.g. `2-2:\n^2-2\n|NEW`).
		// We can't distinguish duplication from intentional pass-through
		// from the parse tree alone.

		const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.range.start } };
		if (payloads.length === 0) {
			this.#pushInsert(cursor, "", lineNum, "replacement");
		} else {
			for (const payload of payloads) {
				this.#emitPayloadRow(cursor, payload, lineNum, "replacement");
			}
		}
		for (const anchor of expandRange(target.range)) {
			this.#pushDelete(anchor, lineNum);
		}

		// L6: track contiguous runs of single-line blank-body replaces. A
		// run of two or more is almost always the model mis-using `A-A:` to
		// mean "delete this line" (it actually replaces with one blank line).
		const isBlankSingleReplace =
			target.range.start.line === target.range.end.line && payloads.length === 0 && !hadBareBody;
		if (isBlankSingleReplace) {
			this.#blankSingleRun++;
			if (this.#blankSingleRun >= 2 && !this.#warnings.includes(STACKED_BLANK_REPLACE_WARNING)) {
				this.#warnings.push(STACKED_BLANK_REPLACE_WARNING);
			}
		} else {
			this.#blankSingleRun = 0;
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
