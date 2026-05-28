/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 *
 * Lifecycle:
 *
 * 1. Construct one {@link Executor} per patch (or share one with `reset()`).
 * 2. Feed it tokens via {@link Executor.feed}. Hunk body rows accumulate
 *    until the next hunk header or {@link end} flushes them.
 * 3. Call {@link Executor.end} to flush the trailing pending hunk and
 *    validate cross-hunk invariants (no overlapping deletes, etc.).
 *
 * Convenience entry point: {@link parsePatch}.
 */
import { HL_PAYLOAD_REPEAT, HL_PAYLOAD_REPLACE } from "./format";
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	PLUS_PREFIXED_REPEAT_WARNING,
	REPLACE_PAIR_COALESCED_OVERLAP_WARNING,
	REPLACE_PAIR_COALESCED_WARNING,
	UNIFIED_DIFF_BODY_AUTO_CONVERT_WARNING,
} from "./messages";
import { type BlockTarget, cloneCursor, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, Cursor, Edit } from "./types";

function validateRangeOrder(range: ParsedRange, lineNum: number): void {
	if (range.end.line < range.start.line) {
		throw new Error(`line ${lineNum}: range ${range.start.line}..${range.end.line} ends before it starts.`);
	}
}

/**
 * If `text` (the slice after a `+` literal sigil) trims to `&A..B` (or `&A`,
 * accepted as `&A,A`), return the parsed range. Otherwise `null`. Used to
 * silently reroute `+&A..B` rows as repeats — models reflexively prefix every
 * body row with `+`, including ones that should be repeats.
 */
function tryParseLiteralAsRepeat(text: string): ParsedRange | null {
	const stripped = text.trim();
	if (stripped.length === 0 || stripped.charCodeAt(0) !== 38 /* & */) return null;
	const match = /^&([1-9]\d*)(?:\.\.([1-9]\d*))?$/.exec(stripped);
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
 * Hashline's own file-header prefix (`¶path#hash`) sits next to
 * apply_patch sentinels (`*** Update File: path`); the latter are caught
 * here. Any `@@`-bracketed shape is also caught — hashline hunks are bare
 * `A B` lines, never `@@ ... @@`.
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
			"File sections start with `¶path#HASH` (no `Update File:` / `Add File:` keyword). " +
			"Hunks are bare `A B` lines with `+TEXT` / `&A..B` body rows."
		);
	}
	if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
		return (
			"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
			"Hashline hunks are bare `A B` lines (or `BOF` / `EOF` keywords)."
		);
	}
	if (trimmed.startsWith("@@")) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. ` +
			"Drop the `@@ ... @@` brackets and write the range directly: `5 7` (`BOF` / `EOF` for virtual positions)."
		);
	}
	if (/^[1-9]\d*\s*$/.test(trimmed)) {
		return (
			`single-number hunk header ${JSON.stringify(trimmed)} is no longer accepted. ` +
			`Spell single-line ranges as \`${trimmed} ${trimmed}\` (two numbers); ` +
			"hashline hunks are bare `A B` lines (or `BOF` / `EOF`)."
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
	 * Bare body rows (no `+`/`&` prefix) buffered while we wait to see
	 * whether the entire hunk body is uniformly unprefixed. On flush, if
	 * every row was bare AND no `+`/`&` row was ever observed for this hunk,
	 * we auto-prepend `+` and emit a {@link BARE_BODY_AUTO_PIPED_WARNING}.
	 */
	pendingRaws: { text: string; lineNum: number }[];
	/**
	 * Set true the first time a `-` row arrives inside the hunk body. From
	 * then on we strip one leading space from raw rows (treating them as
	 * unified-diff context lines) and retroactively strip the same space
	 * from prior `pendingRaws`/`payloads` literals that began with a space.
	 */
	unifiedDiffMode: boolean;
}

/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s.
 *
 * `feed()` accepts tokens one at a time; hunk body rows accumulate until
 * the next hunk header or {@link end} flushes them. After `terminated`
 * flips true (on `envelope-end` or `abort`) subsequent feeds are silently
 * ignored so callers can keep draining their tokenizer.
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
				if (token.target.kind === "range") validateRangeOrder(token.target.range, token.lineNum);

				if (this.#pending !== undefined && targetsEqualConcreteRange(this.#pending.target, token.target)) {
					// Identical-range coalesce: drop the first hunk. Last-wins.
					this.#pending = undefined;
					if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_WARNING)) {
						this.#warnings.push(REPLACE_PAIR_COALESCED_WARNING);
					}
				} else if (
					this.#pending !== undefined &&
					!pendingHasAnyContent(this.#pending) &&
					rangesOverlapBetweenTargets(this.#pending.target, token.target)
				) {
					// Overlapping bare-then-concrete: drop the bare one.
					this.#pending = undefined;
					if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_OVERLAP_WARNING)) {
						this.#warnings.push(REPLACE_PAIR_COALESCED_OVERLAP_WARNING);
					}
				} else {
					this.#flushPending();
				}
				this.#pending = {
					target: token.target,
					lineNum: token.lineNum,
					payloads: [],
					pendingRaws: [],
					unifiedDiffMode: false,
				};
				return;
		}
	}

	/**
	 * Flush any open pending hunk and return the accumulated edits and
	 * warnings. The executor is single-use; {@link reset} is required for
	 * reuse.
	 *
	 * Throws if two hunks target the same line with non-identical ranges.
	 * Identical-range hunks in the same patch are coalesced last-wins by
	 * `feed()` with a warning, so they never reach the validator.
	 */
	end(): { edits: Edit[]; warnings: string[] } {
		this.#consumePendingSkippableComments();
		this.#flushPending();
		this.#validateNoOverlappingDeletes();
		return { edits: this.#edits, warnings: this.#warnings };
	}

	/**
	 * Streaming-tolerant variant of {@link end}. Identical, except a pending
	 * hunk whose body has not yet accumulated any rows is treated as still
	 * in flight and dropped instead of flushed (which would otherwise commit
	 * a destructive delete while the model may still be typing payload).
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
	}

	/**
	 * Each hunk contributes a delete edit per line in its range; if any line
	 * ends up targeted by deletes originating from two different source
	 * hunks (distinguished by their `lineNum`), the patch is internally
	 * inconsistent.
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
				`line ${secondBlock}: anchor line ${anchorLine} is already targeted by another hunk on line ${firstBlock}. ` +
					`Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
	}

	#handleLiteralPayload(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			throw new Error(
				`line ${lineNum}: payload line has no preceding hunk header. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPLACE}${text}`)}.`,
			);
		}
		// Silent recovery: a body row of `+&A..B` (or `+&A` shorthand) is a
		// repeat row the model mistakenly prefixed with `+`. Reroute as a
		// repeat and surface a warning so the model sees the mistake.
		const repeatRange = tryParseLiteralAsRepeat(text);
		if (repeatRange !== null) {
			if (!this.#warnings.includes(PLUS_PREFIXED_REPEAT_WARNING)) {
				this.#warnings.push(PLUS_PREFIXED_REPEAT_WARNING);
			}
			this.#handleRepeatPayload(repeatRange, lineNum);
			return;
		}
		pending.payloads.push({ kind: "literal", text, lineNum });
	}

	#handleRepeatPayload(range: ParsedRange, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			throw new Error(
				`line ${lineNum}: payload line has no preceding hunk header. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPEAT}${range.start.line}..${range.end.line}`)}.`,
			);
		}
		validateRangeOrder(range, lineNum);
		pending.payloads.push({ kind: "repeat", range, lineNum });
	}

	/**
	 * Switch the pending hunk into unified-diff mode and retroactively
	 * strip the leading metadata-space from any literal payloads or
	 * buffered raws that already arrived. Idempotent.
	 */
	#enterUnifiedDiffMode(pending: Pending): void {
		if (pending.unifiedDiffMode) return;
		pending.unifiedDiffMode = true;
		for (const row of pending.pendingRaws) {
			if (row.text.length > 0 && row.text.charCodeAt(0) === 32) {
				row.text = row.text.slice(1);
			}
		}
		for (const payload of pending.payloads) {
			if (payload.kind === "literal" && payload.text.length > 0 && payload.text.charCodeAt(0) === 32) {
				payload.text = payload.text.slice(1);
			}
		}
	}

	#handleRaw(text: string, lineNum: number): void {
		// Detect OpenAI-apply_patch / unified-diff contamination first so the
		// error message names the offending shape instead of the generic
		// "payload row must start with …" diagnostic.
		const contamination = detectApplyPatchContamination(text, this.#pending !== undefined);
		if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`);

		if (this.#pending) {
			if (text.trim().length === 0) return;

			// L9: `-`-prefixed body rows are unified-diff "removed" markers.
			// The hunk header's range already deletes those lines, so we
			// silently drop them and enter unified-diff mode for subsequent
			// rows (which causes leading-space stripping on context lines).
			if (text.charCodeAt(0) === 45 /* - */) {
				this.#enterUnifiedDiffMode(this.#pending);
				if (!this.#warnings.includes(UNIFIED_DIFF_BODY_AUTO_CONVERT_WARNING)) {
					this.#warnings.push(UNIFIED_DIFF_BODY_AUTO_CONVERT_WARNING);
				}
				return;
			}

			// Treat any non-`+`/`&` body row as a literal. When the hunk is
			// in unified-diff mode and the row carries the metadata leading
			// space, strip ONE space so the actual content lands cleanly.
			const literalText =
				this.#pending.unifiedDiffMode && text.charCodeAt(0) === 32 /* space */ ? text.slice(1) : text;
			if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) {
				this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
			}
			this.#pending.payloads.push({ kind: "literal", text: literalText, lineNum });
			return;
		}

		// Whitespace-only raw lines outside any pending block are silently
		// dropped; fully empty lines arrive as `blank` tokens.
		if (text.trim().length === 0) return;

		throw new Error(
			`line ${lineNum}: payload line has no preceding hunk header. ` +
				`Use an \`A B\` (or \`BOF\` / \`EOF\`) line above the body. Got ${JSON.stringify(text)}.`,
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

		// Convert any buffered bare body rows to literal payloads. Mixed
		// blocks have already been rejected; we only get here when payloads
		// `pendingRaws` is kept for type compatibility but no longer used —
		// bare rows are now pushed directly into `payloads` as literals at
		// arrival time (preserving body-row order).
		const { target, lineNum, payloads } = pending;
		if (target.kind === "bof" || target.kind === "eof") {
			const cursor: Cursor = target.kind === "bof" ? { kind: "bof" } : { kind: "eof" };
			for (const payload of payloads) {
				this.#emitPayloadRow(cursor, payload, lineNum);
			}
			// Empty body at BOF/EOF is a no-op (nothing to insert).
			this.#pending = undefined;
			return;
		}

		const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.range.start } };
		// Empty body = pure delete. Otherwise, emit the body rows as
		// replacement payload and delete the original range.
		for (const payload of payloads) {
			this.#emitPayloadRow(cursor, payload, lineNum, "replacement");
		}
		for (const anchor of expandRange(target.range)) {
			this.#pushDelete(anchor, lineNum);
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
 *   collected (the trailing hunk is malformed mid-stream — wait for the
 *   next chunk),
 * - the trailing pending hunk is dropped if it has no payload yet (avoids
 *   a destructive bare-delete preview while payload may still be coming).
 *
 * Throws only on the cross-hunk overlap validator, which catches conflicting
 * shapes (two hunks hitting the same anchor). Streaming preview callers
 * should treat any throw here as "no preview this tick".
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
