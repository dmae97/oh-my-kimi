/**
 * Stateful, line-oriented classifier for hashline diff text.
 *
 * The {@link Tokenizer} can be fed in chunks ({@link Tokenizer.feed}/{@link
 * Tokenizer.end}) for streaming use, or in one shot ({@link
 * Tokenizer.tokenizeAll}). Each emitted token carries its 1-indexed source
 * line number so downstream consumers (parser, validators, error messages)
 * can refer back to the input precisely.
 *
 * The tokenizer is intentionally permissive about decorations and prefixes
 * the model may echo back from `read`/`search` output — leading `*`/`>`/`-`
 * markers, CR-terminated lines, leading whitespace before line numbers, and
 * so on are all stripped before anchor classification.
 */

import {
	describeAnchorExamples,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_OP_REPLACE,
	HL_PAYLOAD_ABOVE,
	HL_PAYLOAD_BELOW,
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
const CHAR_HYPHEN = 45;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_PILCROW = HL_FILE_PREFIX.charCodeAt(0);
const CHAR_OP_REPLACE = HL_OP_REPLACE.charCodeAt(0);
const CHAR_PAYLOAD_REPLACE = HL_PAYLOAD_REPLACE.charCodeAt(0);
const CHAR_PAYLOAD_ABOVE = HL_PAYLOAD_ABOVE.charCodeAt(0);
const CHAR_PAYLOAD_BELOW = HL_PAYLOAD_BELOW.charCodeAt(0);
const FILE_HASH_LENGTH = 4;

function isDigitCode(code: number): boolean {
	return code >= CHAR_ZERO && code <= CHAR_NINE;
}

function isNonZeroDigitCode(code: number): boolean {
	return code > CHAR_ZERO && code <= CHAR_NINE;
}

function isDecorationCode(code: number): boolean {
	return code === 42 || code === CHAR_HYPHEN || code === 62;
}

function isHexDigitCode(code: number): boolean {
	return isDigitCode(code) || (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F);
}

function skipWhitespace(line: string, index: number, end = line.length): number {
	return end - line.slice(index, end).trimStart().length;
}

function trimEndIndex(line: string): number {
	return line.trimEnd().length;
}

function isEmptyLine(line: string): boolean {
	return line.length === 0;
}

function markerLineEquals(line: string, marker: string): boolean {
	return line.trimEnd() === marker;
}

/**
 * Split a hashline diff into individual lines without losing the trailing
 * empty line that callers may rely on for explicit blank payloads. CRLF pairs
 * are normalized to a single line break.
 *
 * This mirrors the line-splitting performed by {@link Tokenizer}'s streaming
 * drain loop and is kept for non-streaming callers that prefer a single-shot
 * split.
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
	if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}

// Leniently accept anchors copied from read/search output:
//   - optional leading line-marker decoration (`*`, `>`, `-`)
//   - the required bare line number / BOF / EOF anchor
function skipDecoratedAnchorPrefix(line: string, end = trimEndIndex(line)): number {
	let index = skipWhitespace(line, 0, end);
	while (index < end && isDecorationCode(line.charCodeAt(index))) index++;
	return skipWhitespace(line, index, end);
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
	const numberStart = skipDecoratedAnchorPrefix(raw, end);
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

function scanRange(line: string, end = trimEndIndex(line)): RangeScan | null {
	const numberStart = skipDecoratedAnchorPrefix(line, end);
	const start = scanLineNumber(line, numberStart, end);
	if (start === null) return null;

	let nextIndex = start.nextIndex;
	let rangeEnd = start.line;
	if (nextIndex < end && line.charCodeAt(nextIndex) === CHAR_HYPHEN) {
		const endNumber = scanLineNumber(line, nextIndex + 1, end);
		if (endNumber === null) return null;
		rangeEnd = endNumber.line;
		nextIndex = endNumber.nextIndex;
	}

	return {
		range: { start: { line: start.line }, end: { line: rangeEnd } },
		nextIndex: skipWhitespace(line, nextIndex, end),
	};
}

function startsWithWord(line: string, index: number, end: number, word: string): boolean {
	if (index + word.length > end) return false;
	for (let offset = 0; offset < word.length; offset++) {
		if (line.charCodeAt(index + offset) !== word.charCodeAt(offset)) return false;
	}
	return true;
}

export type BlockTarget = { kind: "range"; range: ParsedRange } | { kind: "bof" } | { kind: "eof" };

export type PayloadBucket = "above" | "replace" | "below";

interface TargetScan {
	target: BlockTarget;
	nextIndex: number;
}

function scanBlockTarget(line: string, end = trimEndIndex(line)): TargetScan | null {
	const targetStart = skipDecoratedAnchorPrefix(line, end);
	if (startsWithWord(line, targetStart, end, "BOF")) {
		const nextIndex = skipWhitespace(line, targetStart + 3, end);
		return { target: { kind: "bof" }, nextIndex };
	}
	if (startsWithWord(line, targetStart, end, "EOF")) {
		const nextIndex = skipWhitespace(line, targetStart + 3, end);
		return { target: { kind: "eof" }, nextIndex };
	}

	const range = scanRange(line, end);
	return range === null ? null : { target: { kind: "range", range: range.range }, nextIndex: range.nextIndex };
}

interface ParsedBlockOp {
	target: BlockTarget;
	inlineBody: string | undefined;
}

function tryParseBlockOp(line: string): ParsedBlockOp | null {
	const end = trimEndIndex(line);
	const target = scanBlockTarget(line, end);
	if (target === null) return null;

	const opIndex = skipWhitespace(line, target.nextIndex, end);
	if (opIndex >= end || line.charCodeAt(opIndex) !== CHAR_OP_REPLACE) return null;

	const inlineStart = opIndex + HL_OP_REPLACE.length;
	return {
		target: target.target,
		inlineBody: skipWhitespace(line, inlineStart, end) === end ? undefined : line.slice(inlineStart, end),
	};
}

function payloadBucketForCode(code: number): PayloadBucket | undefined {
	if (code === CHAR_PAYLOAD_ABOVE) return "above";
	if (code === CHAR_PAYLOAD_REPLACE) return "replace";
	if (code === CHAR_PAYLOAD_BELOW) return "below";
	return undefined;
}

/**
 * Strict header scan: `¶+` prefix, optional whitespace, path body that
 * excludes whitespace, `#`, and `¶`, optional `#[0-9a-f]{4}` hash suffix,
 * optional trailing whitespace. Returns `null` when any byte deviates from
 * the shape.
 */
function tryParseHeader(line: string): { path: string; fileHash?: string } | null {
	const end = trimEndIndex(line);
	if (end === 0 || line.charCodeAt(0) !== CHAR_PILCROW) return null;

	let index = 0;
	while (index < end && line.charCodeAt(index) === CHAR_PILCROW) index++;
	index = skipWhitespace(line, index, end);
	if (index >= end) return null;

	const pathStart = index;
	while (index < end) {
		const code = line.charCodeAt(index);
		if (code === CHAR_HASH || code === CHAR_PILCROW || code === CHAR_SPACE || code === CHAR_TAB) break;
		index++;
	}
	if (index === pathStart) return null;
	const path = line.slice(pathStart, index);

	let fileHash: string | undefined;
	if (index < end && line.charCodeAt(index) === CHAR_HASH) {
		const hashStart = index + 1;
		const hashEnd = hashStart + FILE_HASH_LENGTH;
		if (hashEnd > end) return null;
		for (let probe = hashStart; probe < hashEnd; probe++) {
			if (!isHexDigitCode(line.charCodeAt(probe))) return null;
		}
		fileHash = line.slice(hashStart, hashEnd);
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
	| (TokenBase & { kind: "op-block"; target: BlockTarget; inlineBody: string | undefined })
	| (TokenBase & { kind: "payload"; bucket: PayloadBucket; text: string })
	| (TokenBase & { kind: "raw"; text: string });

function classifyLine(line: string, lineNum: number): Token {
	if (isEmptyLine(line)) return { kind: "blank", lineNum };
	if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: "envelope-begin", lineNum };
	if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: "envelope-end", lineNum };
	if (markerLineEquals(line, ABORT_MARKER)) return { kind: "abort", lineNum };

	if (line.charCodeAt(0) === CHAR_PILCROW) {
		const header = tryParseHeader(line);
		if (header !== null) {
			return header.fileHash !== undefined
				? { kind: "header", lineNum, path: header.path, fileHash: header.fileHash }
				: { kind: "header", lineNum, path: header.path };
		}
	}

	const payloadBucket = payloadBucketForCode(line.charCodeAt(0));
	if (payloadBucket !== undefined) {
		return { kind: "payload", lineNum, bucket: payloadBucket, text: line.slice(1) };
	}

	const op = tryParseBlockOp(line);
	if (op !== null) return { kind: "op-block", lineNum, target: op.target, inlineBody: op.inlineBody };

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
		return tryParseBlockOp(line) !== null;
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
