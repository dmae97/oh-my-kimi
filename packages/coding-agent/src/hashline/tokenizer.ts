import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "./constants";
import {
	describeAnchorExamples,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_OP_DELETE,
	HL_OP_INSERT_AFTER,
	HL_OP_INSERT_BEFORE,
	HL_OP_REPLACE,
} from "./hash";
import type { Anchor, HashlineCursor } from "./types";

const CHAR_LINE_FEED = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_HASH = 35;
const CHAR_TAB = 9;
const CHAR_SPACE = 32;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_PILCROW = HL_FILE_PREFIX.charCodeAt(0);
const FILE_HASH_LENGTH = 4;

function isDigitCode(code: number): boolean {
	return code >= CHAR_ZERO && code <= CHAR_NINE;
}

function isNonZeroDigitCode(code: number): boolean {
	return code > CHAR_ZERO && code <= CHAR_NINE;
}

function isDecorationCode(code: number): boolean {
	return code === 42 || code === 43 || code === 45 || code === 62;
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
 * This mirrors the line-splitting performed by {@link HashlineTokenizer}'s
 * streaming drain loop and is kept for non-streaming callers that prefer
 * a single-shot split.
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

export function cloneCursor(cursor: HashlineCursor): HashlineCursor {
	if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
	if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}

// Leniently accept anchors copied from read/search output:
//   - optional leading line-marker decoration (`*`, `>`, `+`, `-`)
//   - the required bare line number
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

/** Parse a bare line-number anchor (used by insert ops). Throws on malformed input. */
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

export interface ParsedRange {
	start: Anchor;
	end: Anchor;
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
	if (nextIndex < end && line.charCodeAt(nextIndex) === 45) {
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

function parseInsertTarget(raw: string, lineNum: number, kind: "before" | "after"): HashlineCursor {
	const end = trimEndIndex(raw);
	const targetStart = skipDecoratedAnchorPrefix(raw, end);

	if (startsWithWord(raw, targetStart, end, "BOF") && skipWhitespace(raw, targetStart + 3, end) === end) {
		return { kind: "bof" };
	}
	if (startsWithWord(raw, targetStart, end, "EOF") && skipWhitespace(raw, targetStart + 3, end) === end) {
		return { kind: "eof" };
	}

	const cursorKind = kind === "before" ? "before_anchor" : "after_anchor";
	return { kind: cursorKind, anchor: parseLid(raw, lineNum) };
}

function scanInlineBody(line: string, index: number): string | undefined {
	const end = trimEndIndex(line);
	return index < end ? line.slice(index, end) : undefined;
}

interface ParsedInsertOp {
	kind: "insert";
	cursor: HashlineCursor;
	inlineBody: string | undefined;
}

interface ParsedReplaceOp {
	kind: "replace";
	range: ParsedRange;
	inlineBody: string | undefined;
}

interface ParsedDeleteOp {
	kind: "delete";
	range: ParsedRange;
	trailingPayload: boolean;
}

type ParsedOp = ParsedInsertOp | ParsedReplaceOp | ParsedDeleteOp;

function tryParseInsertOp(line: string, sigil: string, kind: "before" | "after"): ParsedInsertOp | null {
	const end = trimEndIndex(line);
	const targetStart = skipDecoratedAnchorPrefix(line, end);

	let targetEnd: number;
	if (startsWithWord(line, targetStart, end, "BOF") || startsWithWord(line, targetStart, end, "EOF")) {
		targetEnd = targetStart + 3;
	} else {
		const anchor = scanLineNumber(line, targetStart, end);
		if (anchor === null) return null;
		targetEnd = anchor.nextIndex;
	}

	const opIndex = skipWhitespace(line, targetEnd, end);
	if (opIndex >= end || line[opIndex] !== sigil) return null;

	// parseInsertTarget can only throw on inputs that already passed the
	// BOF/EOF/line-number scan above, but guard the throw anyway — the
	// tokenizer contract forbids it and a future refactor of the prefix
	// scan must not silently start raising here.
	try {
		return {
			kind: "insert",
			cursor: parseInsertTarget(line.slice(0, opIndex), 0, kind),
			inlineBody: scanInlineBody(line, opIndex + sigil.length),
		};
	} catch {
		return null;
	}
}

function tryParseReplaceOp(line: string): ParsedReplaceOp | null {
	const end = trimEndIndex(line);
	const range = scanRange(line, end);
	if (range === null || range.nextIndex >= end || line[range.nextIndex] !== HL_OP_REPLACE) return null;
	return {
		kind: "replace",
		range: range.range,
		inlineBody: scanInlineBody(line, range.nextIndex + HL_OP_REPLACE.length),
	};
}

function tryParseDeleteOp(line: string): ParsedDeleteOp | null {
	const end = trimEndIndex(line);
	const range = scanRange(line, end);
	if (range === null || range.nextIndex >= end || line[range.nextIndex] !== HL_OP_DELETE) return null;
	const afterSigil = range.nextIndex + HL_OP_DELETE.length;
	return { kind: "delete", range: range.range, trailingPayload: afterSigil !== end };
}

function tryParseOp(line: string): ParsedOp | null {
	return (
		tryParseInsertOp(line, HL_OP_INSERT_BEFORE, "before") ??
		tryParseInsertOp(line, HL_OP_INSERT_AFTER, "after") ??
		tryParseReplaceOp(line) ??
		tryParseDeleteOp(line)
	);
}

/**
 * Strict header scan: `¶+` prefix, optional whitespace, path body that excludes
 * whitespace, `#`, and `¶`, optional `#[0-9a-f]{4}` hash suffix, optional
 * trailing whitespace. Returns `null` when any byte deviates from the shape.
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

/**
 * Returns true when the line scans as `LINE!payload` (delete sigil followed by
 * additional content). The executor uses this for the dedicated "deletes only"
 * diagnostic, separate from the standard "unrecognized op" path.
 */
export function isDeleteOpWithPayload(line: string): boolean {
	const range = scanRange(line, line.length);
	return (
		range !== null &&
		range.nextIndex < line.length &&
		line[range.nextIndex] === HL_OP_DELETE &&
		range.nextIndex + HL_OP_DELETE.length < line.length
	);
}

interface TokenBase {
	/** 1-indexed line number in the original input stream. */
	lineNum: number;
}

export type HashlineToken =
	| (TokenBase & { kind: "blank" })
	| (TokenBase & { kind: "envelope-begin" })
	| (TokenBase & { kind: "envelope-end" })
	| (TokenBase & { kind: "abort" })
	| (TokenBase & { kind: "header"; path: string; fileHash?: string })
	| (TokenBase & { kind: "op-insert"; cursor: HashlineCursor; inlineBody: string | undefined })
	| (TokenBase & { kind: "op-replace"; range: ParsedRange; inlineBody: string | undefined })
	| (TokenBase & { kind: "op-delete"; range: ParsedRange; trailingPayload: boolean })
	| (TokenBase & { kind: "payload"; text: string });

function classifyLine(line: string, lineNum: number): HashlineToken {
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

	const op = tryParseOp(line);
	if (op !== null) {
		if (op.kind === "insert") {
			return { kind: "op-insert", lineNum, cursor: op.cursor, inlineBody: op.inlineBody };
		}
		if (op.kind === "replace") {
			return { kind: "op-replace", lineNum, range: op.range, inlineBody: op.inlineBody };
		}
		return { kind: "op-delete", lineNum, range: op.range, trailingPayload: op.trailingPayload };
	}

	return { kind: "payload", lineNum, text: line };
}

/**
 * Stateful, line-oriented classifier for hashline diff text. Use the streaming
 * {@link feed}/{@link end} pair to ingest text in chunks (each completed line
 * emits exactly one token; a trailing partial line stays buffered until the
 * next chunk or {@link end}). Use the stateless {@link tokenize}/predicate
 * methods for callers that already hold whole lines and only need
 * classification without buffering.
 */
export class HashlineTokenizer {
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
	feed(chunk: string): HashlineToken[] {
		if (this.#closed) throw new Error("HashlineTokenizer is closed; call reset() before reusing.");
		if (chunk.length === 0) return [];
		this.#buffer = this.#buffer ? this.#buffer + chunk : chunk;
		return this.#drainCompleteLines();
	}

	/**
	 * Flush any buffered residual line (the last line of input when it lacks
	 * a trailing newline) and mark the tokenizer closed. Calling `end` a
	 * second time returns `[]`; reuse requires `reset`.
	 */
	end(): HashlineToken[] {
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
	tokenizeAll(text: string): HashlineToken[] {
		this.reset();
		const first = this.feed(text);
		const last = this.end();
		return last.length === 0 ? first : first.concat(last);
	}

	/** Stateless one-shot classification. Does not touch the streaming buffer. */
	tokenize(line: string, lineNum = 0): HashlineToken {
		return classifyLine(line, lineNum);
	}

	isOp(line: string): boolean {
		return tryParseOp(line) !== null;
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

	#drainCompleteLines(): HashlineToken[] {
		const tokens: HashlineToken[] = [];
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
