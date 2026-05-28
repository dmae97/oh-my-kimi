/**
 * Stateful, line-oriented classifier for hashline diff text.
 *
 * The {@link Tokenizer} can be fed in chunks ({@link Tokenizer.feed}/{@link
 * Tokenizer.end}) for streaming use, or in one shot ({@link
 * Tokenizer.tokenizeAll}). Each emitted token carries its 1-indexed source
 * line number so downstream consumers (parser, validators, error messages)
 * can refer back to the input precisely.
 *
 * Format shape:
 * ```
 * *** path/to/file.ts#0A3
 * @@ 5,7 @@
 * +literal new line
 * &3,4
 * ```
 * Each `***` line opens a new file section; each `@@ A,B @@` line opens a
 * new hunk whose body (zero or more `+`/`&` rows) replaces the selected
 * range. Empty body = delete the selected range.
 */

import {
	describeAnchorExamples,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_PAYLOAD_REPEAT,
	HL_PAYLOAD_REPLACE,
} from "./format";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "./messages";
import type { Anchor, Cursor, ParsedRange } from "./types";

const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_HASH = 35;
const CHAR_TAB = 9;
const CHAR_SPACE = 32;
const CHAR_DOT = 46;
const CHAR_HYPHEN = 45;
const CHAR_ELLIPSIS = 0x2026;

const CHAR_UPPER_A = 65;
const CHAR_UPPER_F = 70;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_PAYLOAD_REPLACE = HL_PAYLOAD_REPLACE.charCodeAt(0);
const CHAR_PAYLOAD_REPEAT = HL_PAYLOAD_REPEAT.charCodeAt(0);
const FILE_PREFIX_LENGTH = HL_FILE_PREFIX.length;
const BOF_ANCHOR = "BOF";
const EOF_ANCHOR = "EOF";

function isDigitCode(code: number): boolean {
	return code >= CHAR_ZERO && code <= CHAR_NINE;
}

function isNonZeroDigitCode(code: number): boolean {
	return code > CHAR_ZERO && code <= CHAR_NINE;
}

function isHexDigitCode(code: number): boolean {
	return (
		isDigitCode(code) ||
		(code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) ||
		(code >= CHAR_LOWER_A && code <= CHAR_LOWER_F)
	);
}

function isWhitespaceCode(code: number): boolean {
	return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN);
}

function skipWhitespace(line: string, index: number, end = line.length): number {
	while (index < end && isWhitespaceCode(line.charCodeAt(index))) index++;
	return index;
}

function trimEndIndex(line: string): number {
	let end = line.length;
	while (end > 0 && isWhitespaceCode(line.charCodeAt(end - 1))) end--;
	return end;
}

function isEmptyLine(line: string): boolean {
	return line.length === 0;
}

function markerLineEquals(line: string, marker: string): boolean {
	const end = trimEndIndex(line);
	return end === marker.length && line.startsWith(marker);
}

/**
 * Split a hashline diff into individual lines without losing the trailing
 * empty line that callers may rely on for explicit blank payloads. CRLF pairs
 * are normalized to a single line break.
 */
export function splitHashlineLines(text: string): string[] {
	if (text.length === 0) return [""];

	const lines: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) !== CHAR_LINE_FEED) continue;
		let end = index;
		if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--;
		lines.push(text.slice(start, end));
		start = index + 1;
	}

	if (start < text.length) {
		let end = text.length;
		if (end > start && text.charCodeAt(end - 1) === CHAR_CARRIAGE_RETURN) end--;
		lines.push(text.slice(start, end));
	}
	return lines;
}

export function cloneCursor(cursor: Cursor): Cursor {
	if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}

interface NumberScan {
	line: number;
	nextIndex: number;
}

function scanLineNumber(line: string, index: number, end: number): NumberScan | null {
	if (index >= end || !isNonZeroDigitCode(line.charCodeAt(index))) return null;

	let lineNumber = 0;
	let nextIndex = index;
	while (nextIndex < end) {
		const code = line.charCodeAt(nextIndex);
		if (!isDigitCode(code)) break;
		lineNumber = lineNumber * 10 + (code - CHAR_ZERO);
		nextIndex++;
	}
	return { line: lineNumber, nextIndex };
}

/** Parse a bare line-number anchor. Throws on malformed input. */
export function parseLid(raw: string, lineNum: number): Anchor {
	const end = trimEndIndex(raw);
	const numberStart = skipWhitespace(raw, 0, end);
	const number = scanLineNumber(raw, numberStart, end);
	if (number === null || skipWhitespace(raw, number.nextIndex, end) !== end) {
		throw new Error(
			`line ${lineNum}: expected a line number such as ${describeAnchorExamples("119")}; ` +
				`got ${JSON.stringify(raw)}. Use ${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}hash from your latest read for file-version binding.`,
		);
	}
	return { line: number.line };
}

interface RangeScan {
	range: ParsedRange;
	nextIndex: number;
}

/**
 * Scan a numeric range for a hunk header. Canonical form is `A B` (two
 * numbers separated by whitespace); models also reflexively emit `A-B`,
 * `A..B`, and `A…B` (unicode ellipsis), so we accept any of those as the
 * range separator. A second number is REQUIRED — bare `A` is not a valid
 * hunk header in this grammar. Repeat-row bodies (`&A..B`) keep their own
 * parser and still accept the `&A` single-line shorthand; see
 * {@link tryParseRepeatPayload}.
 */
function scanHeaderRange(line: string, index = 0, end = trimEndIndex(line)): RangeScan | null {
	const numberStart = skipWhitespace(line, index, end);
	const start = scanLineNumber(line, numberStart, end);
	if (start === null) return null;

	const afterFirst = scanRangeSeparator(line, start.nextIndex, end);
	if (afterFirst === null) return null;
	const endNumber = scanLineNumber(line, afterFirst, end);
	if (endNumber === null) return null;
	return {
		range: { start: { line: start.line }, end: { line: endNumber.line } },
		nextIndex: skipWhitespace(line, endNumber.nextIndex, end),
	};
}

/**
 * Consume the mandatory range separator (whitespace, `-`, `..`, or `…`)
 * between the two numbers of a hunk-header range. Returns the index of
 * the second number, or `null` when the separator is missing or no digit
 * follows it.
 */
function scanRangeSeparator(line: string, index: number, end: number): number | null {
	let cursor = index;
	let consumedSeparator = false;
	while (cursor < end) {
		const code = line.charCodeAt(cursor);
		if (isWhitespaceCode(code)) {
			cursor++;
			consumedSeparator = true;
			continue;
		}
		if (code === CHAR_HYPHEN || code === CHAR_ELLIPSIS) {
			cursor++;
			consumedSeparator = true;
			continue;
		}
		if (code === CHAR_DOT && cursor + 1 < end && line.charCodeAt(cursor + 1) === CHAR_DOT) {
			cursor += 2;
			consumedSeparator = true;
			continue;
		}
		break;
	}
	if (!consumedSeparator) return null;
	if (cursor >= end || !isNonZeroDigitCode(line.charCodeAt(cursor))) return null;
	return cursor;
}

export type BlockTarget = { kind: "range"; range: ParsedRange } | { kind: "bof" } | { kind: "eof" };

interface TargetScan {
	target: BlockTarget;
	nextIndex: number;
}

/**
 * Scan the anchor portion of a hunk header. Accepts `BOF`, `EOF`, or
 * `A B` (range). Single-number anchors are NOT accepted; callers must
 * spell single-line ranges as `A A`.
 */
function scanHunkAnchor(line: string, start: number, end: number): TargetScan | null {
	const cursor = skipWhitespace(line, start, end);
	if (line.startsWith(BOF_ANCHOR, cursor)) {
		return { target: { kind: "bof" }, nextIndex: skipWhitespace(line, cursor + BOF_ANCHOR.length, end) };
	}
	if (line.startsWith(EOF_ANCHOR, cursor)) {
		return { target: { kind: "eof" }, nextIndex: skipWhitespace(line, cursor + EOF_ANCHOR.length, end) };
	}
	const range = scanHeaderRange(line, cursor, end);
	if (range === null) return null;
	return { target: { kind: "range", range: range.range }, nextIndex: range.nextIndex };
}

interface ParsedHunkHeader {
	target: BlockTarget;
}

/**
 * Parse a bare hunk-header line: `A B` (range) or the keywords
 * `BOF` / `EOF`. Returns `null` for lines that do not match the shape.
 */
function tryParseHunkHeader(line: string): ParsedHunkHeader | null {
	const end = trimEndIndex(line);
	const start = skipWhitespace(line, 0, end);
	if (start >= end) return null;
	const scan = scanHunkAnchor(line, start, end);
	if (scan === null) return null;
	if (scan.nextIndex !== end) return null;
	return { target: scan.target };
}

/**
 * Parse a `&A,B` repeat payload row (or `&A` shorthand for `&A,A`). Returns
 * `null` when the line does not match.
 */
function tryParseRepeatPayload(line: string): ParsedRange | null {
	const end = trimEndIndex(line);
	if (line.length === 0 || line.charCodeAt(0) !== CHAR_PAYLOAD_REPEAT) return null;

	const start = scanLineNumber(line, 1, end);
	if (start === null) return null;
	if (start.nextIndex === end) {
		// `&A` shorthand → `&A,A`.
		return { start: { line: start.line }, end: { line: start.line } };
	}
	if (
		start.nextIndex + 1 >= end ||
		line.charCodeAt(start.nextIndex) !== CHAR_DOT ||
		line.charCodeAt(start.nextIndex + 1) !== CHAR_DOT
	)
		return null;

	const finish = scanLineNumber(line, start.nextIndex + 2, end);
	if (finish === null) return null;
	if (skipWhitespace(line, finish.nextIndex, end) !== end) return null;
	return { start: { line: start.line }, end: { line: finish.line } };
}

/**
 * Parse a `¶PATH[#hash]` file-header line. Returns `null` for lines that
 * do not start with the file prefix or that fail the strict shape.
 *
 * `*** Begin Patch` / `*** End Patch` / `*** Abort` markers are matched
 * earlier in {@link classifyLine}, so envelope markers never reach here.
 */
function tryParseHeader(line: string): { path: string; fileHash?: string } | null {
	if (!line.startsWith(HL_FILE_PREFIX)) return null;
	const end = trimEndIndex(line);
	let index = FILE_PREFIX_LENGTH;
	if (index >= end) return null;

	const pathStart = index;
	while (index < end) {
		const code = line.charCodeAt(index);
		if (code === CHAR_HASH || code === CHAR_SPACE || code === CHAR_TAB) break;
		index++;
	}
	if (index === pathStart) return null;
	const path = line.slice(pathStart, index);

	let fileHash: string | undefined;
	if (index < end && line.charCodeAt(index) === CHAR_HASH) {
		const hashStart = index + 1;
		const hashEnd = hashStart + HL_FILE_HASH_LENGTH;
		if (hashEnd > end) return null;
		for (let probe = hashStart; probe < hashEnd; probe++) {
			if (!isHexDigitCode(line.charCodeAt(probe))) return null;
		}
		fileHash = line.slice(hashStart, hashEnd).toUpperCase();
		index = hashEnd;
	}

	// Anything other than trailing whitespace disqualifies the header.
	if (skipWhitespace(line, index, end) !== end) return null;

	return fileHash !== undefined ? { path, fileHash } : { path };
}

interface TokenBase {
	/** 1-indexed line number in the original input stream. */
	lineNum: number;
}

export type Token =
	| (TokenBase & { kind: "blank" })
	| (TokenBase & { kind: "envelope-begin" })
	| (TokenBase & { kind: "envelope-end" })
	| (TokenBase & { kind: "abort" })
	| (TokenBase & { kind: "header"; path: string; fileHash?: string })
	| (TokenBase & { kind: "op-block"; target: BlockTarget })
	| (TokenBase & { kind: "payload-literal"; text: string })
	| (TokenBase & { kind: "payload-repeat"; range: ParsedRange })
	| (TokenBase & { kind: "raw"; text: string });

function classifyLine(line: string, lineNum: number): Token {
	if (isEmptyLine(line)) return { kind: "blank", lineNum };
	if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: "envelope-begin", lineNum };
	if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: "envelope-end", lineNum };
	if (markerLineEquals(line, ABORT_MARKER)) return { kind: "abort", lineNum };

	const firstCode = line.charCodeAt(0);

	if (line.startsWith(HL_FILE_PREFIX)) {
		const header = tryParseHeader(line);
		if (header !== null) {
			return header.fileHash !== undefined
				? { kind: "header", lineNum, path: header.path, fileHash: header.fileHash }
				: { kind: "header", lineNum, path: header.path };
		}
	}

	// Hunk header lines are `A B` (two numbers) or the keyword `BOF` /
	// `EOF`. `@@`-bracketed forms are intentionally NOT accepted here —
	// they fall through to `raw` and the parser rejects them as
	// apply_patch contamination.
	const isHunkLead = isNonZeroDigitCode(firstCode) || line.startsWith(BOF_ANCHOR) || line.startsWith(EOF_ANCHOR);
	if (isHunkLead) {
		const hunk = tryParseHunkHeader(line);
		if (hunk !== null) return { kind: "op-block", lineNum, target: hunk.target };
	}

	if (firstCode === CHAR_PAYLOAD_REPLACE) {
		return { kind: "payload-literal", lineNum, text: line.slice(1) };
	}
	if (firstCode === CHAR_PAYLOAD_REPEAT) {
		const range = tryParseRepeatPayload(line);
		if (range !== null) return { kind: "payload-repeat", lineNum, range };
	}

	return { kind: "raw", lineNum, text: line };
}

/**
 * Stateful, line-oriented classifier for hashline diff text. Use the
 * streaming {@link feed}/{@link end} pair to ingest text in chunks (each
 * completed line emits exactly one token; a trailing partial line stays
 * buffered until the next chunk or {@link end}). Use the stateless
 * {@link tokenize}/predicate methods for callers that already hold whole
 * lines and only need classification without buffering.
 */
export class Tokenizer {
	#buffer = "";
	#nextLineNum = 1;
	#closed = false;

	/**
	 * Ingest a chunk of input text. Each newline-terminated line in the
	 * combined buffer produces one token. A trailing partial line (no `\n`
	 * yet, possibly ending in a lone `\r`) stays buffered until the next
	 * `feed`/`end` call so CRLF pairs that straddle chunk boundaries are
	 * still normalized correctly.
	 */
	feed(chunk: string): Token[] {
		if (this.#closed) throw new Error("Tokenizer is closed; call reset() before reusing.");
		if (chunk.length === 0) return [];
		this.#buffer = this.#buffer ? this.#buffer + chunk : chunk;
		return this.#drainCompleteLines();
	}

	/**
	 * Flush any buffered residual line (the last line of input when it lacks
	 * a trailing newline) and mark the tokenizer closed. Calling `end` a
	 * second time returns `[]`; reuse requires `reset`.
	 */
	end(): Token[] {
		if (this.#closed) return [];
		this.#closed = true;
		const buf = this.#buffer;
		this.#buffer = "";
		if (buf.length === 0) return [];
		let stop = buf.length;
		if (buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--;
		const token = classifyLine(buf.slice(0, stop), this.#nextLineNum++);
		return [token];
	}

	/** Discard any buffered text and reset the line counter to 1. */
	reset(): void {
		this.#buffer = "";
		this.#nextLineNum = 1;
		this.#closed = false;
	}

	/** Convenience: feed an entire text and immediately flush. */
	tokenizeAll(text: string): Token[] {
		this.reset();
		const first = this.feed(text);
		const last = this.end();
		return last.length === 0 ? first : first.concat(last);
	}

	/** Stateless one-shot classification. Does not touch the streaming buffer. */
	tokenize(line: string, lineNum = 0): Token {
		return classifyLine(line, lineNum);
	}

	isOp(line: string): boolean {
		return tryParseHunkHeader(line) !== null;
	}

	isHeader(line: string): boolean {
		return tryParseHeader(line) !== null;
	}

	isEnvelopeMarker(line: string): boolean {
		return (
			markerLineEquals(line, BEGIN_PATCH_MARKER) ||
			markerLineEquals(line, END_PATCH_MARKER) ||
			markerLineEquals(line, ABORT_MARKER)
		);
	}

	#drainCompleteLines(): Token[] {
		const tokens: Token[] = [];
		const buf = this.#buffer;
		let start = 0;
		for (let index = 0; index < buf.length; index++) {
			if (buf.charCodeAt(index) !== CHAR_LINE_FEED) continue;
			let stop = index;
			if (stop > start && buf.charCodeAt(stop - 1) === CHAR_CARRIAGE_RETURN) stop--;
			tokens.push(classifyLine(buf.slice(start, stop), this.#nextLineNum++));
			start = index + 1;
		}
		this.#buffer = start < buf.length ? buf.slice(start) : "";
		return tokens;
	}
}

export type { ParsedRange } from "./types";
