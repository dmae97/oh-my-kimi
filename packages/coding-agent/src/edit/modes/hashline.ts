/**
 * Hashline edit mode.
 *
 * A compact, line-anchored wire format for file edits. Each section starts
 * with `@PATH`. Edit ops are explicit blocks (`+ ANCHOR`, `- A..B`, `= A..B`)
 * with payload lines prefixed by `|`.
 *
 * The module is organized into the following sections:
 *
 *   1.  Imports
 *   2.  Public types & schemas
 *   3.  Constants & shared regexes
 *   4.  Small string utilities
 *   5.  Read-output prefix stripping  (stripNewLinePrefixes, hashlineParseText)
 *   6.  Hashline streaming            (streamHashLinesFromUtf8)
 *   7.  Anchor parsing & validation   (parseTag, parseLid, parseRange, ...)
 *   8.  Mismatch error & rebase       (HashlineMismatchError, tryRebaseAnchor)
 *   9.  Compact diff preview          (buildCompactHashlineDiffPreview)
 *  10.  Edit DSL parsing              (parseHashline, parseHashlineWithWarnings)
 *  11.  Edit application              (applyHashlineEdits)
 *  12.  Input splitting               (splitHashlineInput, splitHashlineInputs)
 *  13.  Diff computation              (computeHashlineDiff)
 *  14.  Execution                     (executeHashlineSingle)
 */

// ───────────────────────────────────────────────────────────────────────────
// 1. Imports
// ───────────────────────────────────────────────────────────────────────────

import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { formatCodeFrameLine } from "../../tools/render-utils";
import { generateDiffString } from "../diff";
import {
	computeLineHash,
	describeAnchorExamples,
	formatHashLine,
	HASHLINE_ANCHOR_RE_SRC,
	HASHLINE_CONTENT_SEPARATOR,
	HASHLINE_CONTENT_SEPARATOR_RE_SRC,
	HASHLINE_LID_CAPTURE_RE_SRC,
} from "../line-hash";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import type { EditToolDetails, LspBatchRequest } from "../renderer";

// ───────────────────────────────────────────────────────────────────────────
// 2. Public types & schemas
// ───────────────────────────────────────────────────────────────────────────

export interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

export type Anchor = {
	line: number;
	hash: string;
	contentHint?: string;
};

type HashlineCursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

export type HashlineEdit =
	| { kind: "insert"; cursor: HashlineCursor; text: string; lineNum: number; index: number }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string };

export const hashlineEditParamsSchema = Type.Object({ input: Type.String() });
export type HashlineParams = Static<typeof hashlineEditParamsSchema>;

export interface HashlineStreamOptions {
	/** First line number to use when formatting (1-indexed). */
	startLine?: number;
	/** Maximum formatted lines per yielded chunk (default: 200). */
	maxChunkLines?: number;
	/** Maximum UTF-8 bytes per yielded chunk (default: 64 KiB). */
	maxChunkBytes?: number;
}

export interface CompactHashlineDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

export interface CompactHashlineDiffOptions {
	/** Maximum entries kept on each side of an unchanged-context truncation (default: 2). */
	maxUnchangedRun?: number;
}

export interface SplitHashlineOptions {
	cwd?: string;
	path?: string;
}

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	path?: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Constants & shared regexes
// ───────────────────────────────────────────────────────────────────────────

/** How far either side of an anchor we'll search when auto-rebasing on hash match. */
export const ANCHOR_REBASE_WINDOW = 5;

/** Lines of context shown either side of a hash mismatch. */
const MISMATCH_CONTEXT = 2;

/** Filler hash used for the interior of a multi-line range; not validated. */
const RANGE_INTERIOR_HASH = "**";

/** Header marker introducing a new file section in multi-section input. */
const FILE_HEADER_PREFIX = "@";

const HASHLINE_CONTENT_SEPARATOR_RE = `[:${HASHLINE_CONTENT_SEPARATOR_RE_SRC}]`;
const HASHLINE_PREFIX_RE = new RegExp(`^\\s*(?:>>>|>>)?\\s*(?:[+*]\\s*)?\\d+[a-z]{2}${HASHLINE_CONTENT_SEPARATOR_RE}`);
const HASHLINE_PREFIX_PLUS_RE = new RegExp(`^\\s*(?:>>>|>>)?\\s*\\+\\s*\\d+[a-z]{2}${HASHLINE_CONTENT_SEPARATOR_RE}`);
const DIFF_PLUS_RE = /^[+](?![+])/;
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bsel=L?\d+/;

const HASHLINE_HASH_HINT_RE = /^[a-z]{2}$/i;
const HASHLINE_ANCHOR_EXAMPLES = describeAnchorExamples("160");

const PARSE_TAG_RE = new RegExp(`^${HASHLINE_ANCHOR_RE_SRC}`);
const LID_CAPTURE_RE = new RegExp(`^${HASHLINE_LID_CAPTURE_RE_SRC}$`);

// ───────────────────────────────────────────────────────────────────────────
// 4. Small string utilities
// ───────────────────────────────────────────────────────────────────────────

function stripTrailingCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function stripLeadingHashlinePrefixes(line: string): string {
	let result = line;
	let previous: string;
	do {
		previous = result;
		result = result.replace(HASHLINE_PREFIX_RE, "");
	} while (result !== previous);
	return result;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Read-output prefix stripping
//
// When a model echoes back content from a `read` or `search` response, every
// line is prefixed with either a hashline tag (`123ab|`) or, for diff-style
// echoes, a leading `+`. These helpers detect that and recover the raw text.
// ───────────────────────────────────────────────────────────────────────────

type LinePrefixStats = {
	nonEmpty: number;
	hashPrefixCount: number;
	diffPlusHashPrefixCount: number;
	diffPlusCount: number;
	truncationNoticeCount: number;
};

function collectLinePrefixStats(lines: string[]): LinePrefixStats {
	const stats: LinePrefixStats = {
		nonEmpty: 0,
		hashPrefixCount: 0,
		diffPlusHashPrefixCount: 0,
		diffPlusCount: 0,
		truncationNoticeCount: 0,
	};

	for (const line of lines) {
		if (line.length === 0) continue;
		if (READ_TRUNCATION_NOTICE_RE.test(line)) {
			stats.truncationNoticeCount++;
			continue;
		}
		stats.nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(line)) stats.hashPrefixCount++;
		if (HASHLINE_PREFIX_PLUS_RE.test(line)) stats.diffPlusHashPrefixCount++;
		if (DIFF_PLUS_RE.test(line)) stats.diffPlusCount++;
	}
	return stats;
}

export function stripNewLinePrefixes(lines: string[]): string[] {
	const stats = collectLinePrefixStats(lines);
	if (stats.nonEmpty === 0) return lines;

	const stripHash = stats.hashPrefixCount > 0 && stats.hashPrefixCount === stats.nonEmpty;
	const stripPlus =
		!stripHash &&
		stats.diffPlusHashPrefixCount === 0 &&
		stats.diffPlusCount > 0 &&
		stats.diffPlusCount >= stats.nonEmpty * 0.5;

	if (!stripHash && !stripPlus && stats.diffPlusHashPrefixCount === 0) return lines;

	return lines
		.filter(line => !READ_TRUNCATION_NOTICE_RE.test(line))
		.map(line => {
			if (stripHash) return stripLeadingHashlinePrefixes(line);
			if (stripPlus) return line.replace(DIFF_PLUS_RE, "");
			if (stats.diffPlusHashPrefixCount > 0 && HASHLINE_PREFIX_PLUS_RE.test(line)) {
				return line.replace(HASHLINE_PREFIX_RE, "");
			}
			return line;
		});
}

export function stripHashlinePrefixes(lines: string[]): string[] {
	const stats = collectLinePrefixStats(lines);
	if (stats.nonEmpty === 0) return lines;
	if (stats.hashPrefixCount !== stats.nonEmpty) return lines;
	return lines.filter(line => !READ_TRUNCATION_NOTICE_RE.test(line)).map(line => stripLeadingHashlinePrefixes(line));
}

/**
 * Normalize line payloads by stripping read/search line prefixes. `null` /
 * `undefined` yield `[]`; a single multiline string is split on `\n`.
 */
export function hashlineParseText(edit: string[] | string | null | undefined): string[] {
	if (edit == null) return [];
	if (typeof edit === "string") {
		const trimmed = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
		edit = trimmed.replaceAll("\r", "").split("\n");
	}
	return stripNewLinePrefixes(edit);
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Hashline streaming
//
// Convert a UTF-8 byte stream into a sequence of formatted hashline chunks,
// each capped by line count and byte size.
// ───────────────────────────────────────────────────────────────────────────

interface ResolvedHashlineStreamOptions {
	startLine: number;
	maxChunkLines: number;
	maxChunkBytes: number;
}

function resolveHashlineStreamOptions(options: HashlineStreamOptions): ResolvedHashlineStreamOptions {
	return {
		startLine: options.startLine ?? 1,
		maxChunkLines: options.maxChunkLines ?? 200,
		maxChunkBytes: options.maxChunkBytes ?? 64 * 1024,
	};
}

interface HashlineChunkEmitter {
	pushLine: (line: string) => string[];
	flush: () => string | undefined;
}

function createHashlineChunkEmitter(options: ResolvedHashlineStreamOptions): HashlineChunkEmitter {
	let lineNumber = options.startLine;
	let outLines: string[] = [];
	let outBytes = 0;

	const flush = (): string | undefined => {
		if (outLines.length === 0) return undefined;
		const chunk = outLines.join("\n");
		outLines = [];
		outBytes = 0;
		return chunk;
	};

	const pushLine = (line: string): string[] => {
		const formatted = formatHashLine(lineNumber, line);
		lineNumber++;

		const chunks: string[] = [];
		const sepBytes = outLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(formatted, "utf-8");
		const wouldOverflow =
			outLines.length >= options.maxChunkLines || outBytes + sepBytes + lineBytes > options.maxChunkBytes;

		if (outLines.length > 0 && wouldOverflow) {
			const flushed = flush();
			if (flushed) chunks.push(flushed);
		}

		outLines.push(formatted);
		outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

		if (outLines.length >= options.maxChunkLines || outBytes >= options.maxChunkBytes) {
			const flushed = flush();
			if (flushed) chunks.push(flushed);
		}
		return chunks;
	};

	return { pushLine, flush };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return (
		typeof value === "object" &&
		value !== null &&
		"getReader" in value &&
		typeof (value as { getReader?: unknown }).getReader === "function"
	);
}

async function* bytesFromReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function* streamHashLinesFromUtf8(
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const resolved = resolveHashlineStreamOptions(options);
	const decoder = new TextDecoder("utf-8");
	const chunks = isReadableStream(source) ? bytesFromReadableStream(source) : source;
	const emitter = createHashlineChunkEmitter(resolved);

	let pending = "";
	let sawAnyLine = false;

	for await (const chunk of chunks) {
		pending += decoder.decode(chunk, { stream: true });
		let nl = pending.indexOf("\n");
		while (nl !== -1) {
			const raw = pending.slice(0, nl);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			sawAnyLine = true;
			for (const out of emitter.pushLine(line)) yield out;
			pending = pending.slice(nl + 1);
			nl = pending.indexOf("\n");
		}
	}

	pending += decoder.decode();
	if (pending.length > 0) {
		sawAnyLine = true;
		const tail = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
		for (const out of emitter.pushLine(tail)) yield out;
	}
	if (!sawAnyLine) {
		for (const out of emitter.pushLine("")) yield out;
	}

	const last = emitter.flush();
	if (last) yield last;
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Anchor parsing & validation
// ───────────────────────────────────────────────────────────────────────────

export function formatFullAnchorRequirement(raw?: string): string {
	const suffix = typeof raw === "string" ? raw.trim() : "";
	const hashOnlyHint = HASHLINE_HASH_HINT_RE.test(suffix)
		? ` It looks like you supplied only the hash suffix (${JSON.stringify(suffix)}). ` +
			`Copy the full anchor exactly as shown (for example, "160${suffix}").`
		: "";
	const received = raw === undefined ? "" : ` Received ${JSON.stringify(raw)}.`;
	return (
		`the full anchor exactly as shown by read/search output ` +
		`(line number + hash, for example ${HASHLINE_ANCHOR_EXAMPLES})${received}${hashOnlyHint}`
	);
}

export function parseTag(ref: string): { line: number; hash: string } {
	const match = ref.match(PARSE_TAG_RE);
	if (!match) {
		throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	return { line, hash: match[2] };
}

function parseLid(raw: string, lineNum: number): Anchor {
	const match = LID_CAPTURE_RE.exec(raw);
	if (!match) {
		throw new Error(
			`line ${lineNum}: expected a full anchor such as ${describeAnchorExamples("119")}; ` +
				`got ${JSON.stringify(raw)}.`,
		);
	}
	return { line: Number.parseInt(match[1], 10), hash: match[2] };
}

interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

function parseRange(raw: string, lineNum: number): ParsedRange {
	const [startRaw, endRaw] = raw.split("..");
	if (!startRaw) throw new Error(`line ${lineNum}: range is missing its first anchor.`);
	const start = parseLid(startRaw, lineNum);
	const end = endRaw === undefined ? { ...start } : parseLid(endRaw, lineNum);
	if (end.line < start.line) {
		throw new Error(`line ${lineNum}: range ${startRaw}..${endRaw} ends before it starts.`);
	}
	if (end.line === start.line && end.hash !== start.hash) {
		throw new Error(`line ${lineNum}: range ${startRaw}..${endRaw} uses two different hashes for the same line.`);
	}
	return { start, end };
}

function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) {
		const hash =
			line === range.start.line ? range.start.hash : line === range.end.line ? range.end.hash : RANGE_INTERIOR_HASH;
		anchors.push({ line, hash });
	}
	return anchors;
}

function parseInsertTarget(raw: string, lineNum: number, kind: "before" | "after"): HashlineCursor {
	if (raw === "BOF") return { kind: "bof" };
	if (raw === "EOF") return { kind: "eof" };
	const cursorKind = kind === "before" ? "before_anchor" : "after_anchor";
	return { kind: cursorKind, anchor: parseLid(raw, lineNum) };
}

export function validateLineRef(ref: { line: number; hash: string }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1] ?? "");
	if (actualHash !== ref.hash) {
		throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Mismatch error & rebase
// ───────────────────────────────────────────────────────────────────────────

function getMismatchDisplayLines(mismatches: HashMismatch[], fileLines: string[]): number[] {
	const displayLines = new Set<number>();
	for (const mismatch of mismatches) {
		const lo = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
		for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
	}
	return [...displayLines].sort((a, b) => a - b);
}

export class HashlineMismatchError extends Error {
	readonly remaps: ReadonlyMap<string, string>;

	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";

		const remaps = new Map<string, string>();
		for (const mismatch of mismatches) {
			const actual = computeLineHash(mismatch.line, fileLines[mismatch.line - 1] ?? "");
			remaps.set(`${mismatch.line}${mismatch.expected}`, `${mismatch.line}${actual}`);
		}
		this.remaps = remaps;
	}

	get displayMessage(): string {
		return HashlineMismatchError.formatDisplayMessage(this.mismatches, this.fileLines);
	}

	private static rejectionHeader(mismatches: HashMismatch[]): string[] {
		const noun = mismatches.length > 1 ? "lines have" : "line has";
		return [
			`Edit rejected: ${mismatches.length} ${noun} changed since the last read (marked *).`,
			"The edit was NOT applied, please use the updated file content shown below, and issue another edit tool-call.",
		];
	}

	static formatDisplayMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Set<number>(mismatches.map(m => m.line));
		const displayLines = getMismatchDisplayLines(mismatches, fileLines);
		const width = displayLines.reduce((cur, n) => Math.max(cur, String(n).length), 0);

		const out = [...HashlineMismatchError.rejectionHeader(mismatches), ""];
		let previous = -1;
		for (const lineNum of displayLines) {
			if (previous !== -1 && lineNum > previous + 1) out.push("...");
			previous = lineNum;
			const marker = mismatchSet.has(lineNum) ? "*" : " ";
			out.push(formatCodeFrameLine(marker, lineNum, fileLines[lineNum - 1] ?? "", width));
		}
		return out.join("\n");
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Set<number>(mismatches.map(m => m.line));
		const lines = HashlineMismatchError.rejectionHeader(mismatches);
		let previous = -1;
		for (const lineNum of getMismatchDisplayLines(mismatches, fileLines)) {
			if (previous !== -1 && lineNum > previous + 1) lines.push("...");
			previous = lineNum;
			const text = fileLines[lineNum - 1] ?? "";
			const hash = computeLineHash(lineNum, text);
			const marker = mismatchSet.has(lineNum) ? "*" : " ";
			lines.push(`${marker}${lineNum}${hash}${HASHLINE_CONTENT_SEPARATOR}${text}`);
		}
		return lines.join("\n");
	}
}

/**
 * Try to find a unique line within ±window where the file's actual hash
 * matches the anchor's expected hash. Returns the new line number, or `null`
 * if zero or multiple candidates were found.
 */
export function tryRebaseAnchor(
	anchor: { line: number; hash: string },
	fileLines: string[],
	window: number = ANCHOR_REBASE_WINDOW,
): number | null {
	const lo = Math.max(1, anchor.line - window);
	const hi = Math.min(fileLines.length, anchor.line + window);
	let found: number | null = null;
	for (let lineNum = lo; lineNum <= hi; lineNum++) {
		if (computeLineHash(lineNum, fileLines[lineNum - 1] ?? "") !== anchor.hash) continue;
		if (found !== null) return null;
		found = lineNum;
	}
	return found;
}

// ───────────────────────────────────────────────────────────────────────────
// 9. Compact diff preview
// ───────────────────────────────────────────────────────────────────────────

export function buildCompactHashlineDiffPreview(
	diff: string,
	_options: CompactHashlineDiffOptions = {},
): CompactHashlineDiffPreview {
	const lines = diff.length === 0 ? [] : diff.split("\n");
	let addedLines = 0;
	let removedLines = 0;

	// `generateDiffString` numbers `+` lines with the post-edit line number,
	// `-` lines with the pre-edit line number, and context lines with the
	// pre-edit line number. To emit fresh anchors usable for follow-up edits,
	// we convert context-line numbers to post-edit positions by tracking the
	// running offset (added so far - removed so far) as we walk the diff.
	const formatted = lines.map(line => {
		const kind = line[0];
		if (kind !== "+" && kind !== "-" && kind !== " ") return line;

		const body = line.slice(1);
		const sep = body.indexOf("|");
		if (sep === -1) return line;

		const lineNumber = Number.parseInt(body.slice(0, sep), 10);
		const content = body.slice(sep + 1);

		switch (kind) {
			case "+":
				addedLines++;
				return `+${lineNumber}${computeLineHash(lineNumber, content)}${HASHLINE_CONTENT_SEPARATOR}${content}`;
			case "-":
				removedLines++;
				return `-${lineNumber}--${HASHLINE_CONTENT_SEPARATOR}${content}`;
			default: {
				const newLineNumber = lineNumber + addedLines - removedLines;
				return ` ${newLineNumber}${computeLineHash(newLineNumber, content)}${HASHLINE_CONTENT_SEPARATOR}${content}`;
			}
		}
	});

	return { preview: formatted.join("\n"), addedLines, removedLines };
}

// ───────────────────────────────────────────────────────────────────────────
// 10. Edit DSL parsing
//
// Grammar (one op per "block"):
//   "+ ANCHOR"   followed by 1+ "<sep>TEXT" payload lines        — insert
//   "- A..B"     no payload                                     — delete range
//   "= A..B"     followed by 1+ "<sep>TEXT" payload lines        — replace
//
// ANCHOR is `LINE<hash>`, e.g. `160ab`. BOF / EOF are also valid insert targets.
// ───────────────────────────────────────────────────────────────────────────

const INSERT_BEFORE_OP_RE = /^<\s*(\S+)$/;
const INSERT_AFTER_OP_RE = /^\+\s*(\S+)$/;
const DELETE_OP_RE = /^-\s*(\S+)$/;
const REPLACE_OP_RE = /^=\s*(\S+)$/;

function cloneCursor(cursor: HashlineCursor): HashlineCursor {
	if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
	if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}

function collectPayload(
	lines: string[],
	startIndex: number,
	opLineNum: number,
	requirePayload: boolean,
): { payload: string[]; nextIndex: number } {
	const payload: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const line = stripTrailingCarriageReturn(lines[index]);
		if (!line.startsWith(HASHLINE_CONTENT_SEPARATOR)) break;
		payload.push(line.slice(1));
		index++;
	}
	if (payload.length === 0 && requirePayload) {
		throw new Error(`line ${opLineNum}: + and < operations require at least one |TEXT payload line.`);
	}
	return { payload, nextIndex: index };
}

export function parseHashline(diff: string): HashlineEdit[] {
	return parseHashlineWithWarnings(diff).edits;
}

export function parseHashlineWithWarnings(diff: string): { edits: HashlineEdit[]; warnings: string[] } {
	const edits: HashlineEdit[] = [];
	const warnings: string[] = [];
	const lines = diff.split("\n");
	let editIndex = 0;

	const pushInsert = (cursor: HashlineCursor, text: string, lineNum: number) => {
		edits.push({ kind: "insert", cursor: cloneCursor(cursor), text, lineNum, index: editIndex++ });
	};

	for (let i = 0; i < lines.length; ) {
		const lineNum = i + 1;
		const line = stripTrailingCarriageReturn(lines[i]);

		if (line.trim().length === 0) {
			i++;
			continue;
		}
		if (line.startsWith(HASHLINE_CONTENT_SEPARATOR)) {
			throw new Error(`line ${lineNum}: payload line has no preceding +, <, or = operation.`);
		}

		const insertBeforeMatch = INSERT_BEFORE_OP_RE.exec(line);
		if (insertBeforeMatch) {
			const cursor = parseInsertTarget(insertBeforeMatch[1], lineNum, "before");
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, true);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const insertAfterMatch = INSERT_AFTER_OP_RE.exec(line);
		if (insertAfterMatch) {
			const cursor = parseInsertTarget(insertAfterMatch[1], lineNum, "after");
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, true);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const deleteMatch = DELETE_OP_RE.exec(line);
		if (deleteMatch) {
			for (const anchor of expandRange(parseRange(deleteMatch[1], lineNum))) {
				edits.push({ kind: "delete", anchor, lineNum, index: editIndex++ });
			}
			i++;
			continue;
		}

		const replaceMatch = REPLACE_OP_RE.exec(line);
		if (replaceMatch) {
			const range = parseRange(replaceMatch[1], lineNum);
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, false);
			// `= A..B` with no payload blanks the range to a single empty line.
			const replacement = payload.length === 0 ? [""] : payload;
			for (const text of replacement) {
				edits.push({
					kind: "insert",
					cursor: { kind: "before_anchor", anchor: { ...range.start } },
					text,
					lineNum,
					index: editIndex++,
				});
			}
			for (const anchor of expandRange(range)) {
				edits.push({ kind: "delete", anchor, lineNum, index: editIndex++ });
			}
			i = nextIndex;
			continue;
		}

		throw new Error(
			`line ${lineNum}: unrecognized op. Use < ANCHOR (insert before), + ANCHOR (insert after), - A..B (delete), = A..B (replace), or "${HASHLINE_CONTENT_SEPARATOR}TEXT" payload lines. ` +
				`Got ${JSON.stringify(line)}.`,
		);
	}

	return { edits, warnings };
}

// ───────────────────────────────────────────────────────────────────────────
// 11. Edit application
// ───────────────────────────────────────────────────────────────────────────

interface HashlineApplyResult {
	lines: string;
	firstChangedLine?: number;
	warnings?: string[];
	noopEdits?: HashlineNoopEdit[];
}

interface HashlineNoopEdit {
	editIndex: number;
	loc: string;
	reason: string;
	current: string;
}

type HashlineLineOrigin = "original" | "insert" | "replacement";

interface IndexedEdit {
	edit: HashlineEdit;
	idx: number;
}

function getHashlineEditAnchors(edit: HashlineEdit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	if (edit.cursor.kind === "before_anchor") return [edit.cursor.anchor];
	if (edit.cursor.kind === "after_anchor") return [edit.cursor.anchor];
	return [];
}

/**
 * Verify every anchor's hash, attempting a small ±window rebase before
 * reporting a mismatch. Mutates anchors in place when rebased. Also detects
 * ambiguous cases where two edits target the same line via different anchors,
 * one of which had to be rebased (treated as a mismatch).
 */
function validateHashlineAnchors(edits: HashlineEdit[], fileLines: string[], warnings: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	const rebasedAnchors = new Map<Anchor, HashMismatch>();
	const emittedRebaseKeys = new Set<string>();

	for (const edit of edits) {
		for (const anchor of getHashlineEditAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
			if (anchor.hash === RANGE_INTERIOR_HASH) continue;

			const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1] ?? "");
			if (actualHash === anchor.hash) continue;

			const rebased = tryRebaseAnchor(anchor, fileLines);
			if (rebased !== null) {
				const original = `${anchor.line}${anchor.hash}`;
				rebasedAnchors.set(anchor, { line: anchor.line, expected: anchor.hash, actual: actualHash });
				anchor.line = rebased;
				const rebaseKey = `${original}→${rebased}${anchor.hash}`;
				if (!emittedRebaseKeys.has(rebaseKey)) {
					emittedRebaseKeys.add(rebaseKey);
					warnings.push(
						`Auto-rebased anchor ${original} → ${rebased}${anchor.hash} ` +
							`(line shifted within ±${ANCHOR_REBASE_WINDOW}; hash matched).`,
					);
				}
				continue;
			}
			mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
		}
	}

	// Detect collisions: two delete edits resolving to the same line, where at
	// least one had to be rebased — that's likely the rebase landing on the
	// wrong row, so surface the original mismatch.
	const seenLines = new Map<number, Anchor>();
	for (const edit of edits) {
		if (edit.kind !== "delete") continue;
		const existing = seenLines.get(edit.anchor.line);
		if (existing) {
			const rebasedA = rebasedAnchors.get(edit.anchor);
			const rebasedB = rebasedAnchors.get(existing);
			if (rebasedA) mismatches.push(rebasedA);
			else if (rebasedB) mismatches.push(rebasedB);
			continue;
		}
		seenLines.set(edit.anchor.line, edit.anchor);
	}

	return mismatches;
}

function insertAtStart(fileLines: string[], lineOrigins: HashlineLineOrigin[], lines: string[]): void {
	if (lines.length === 0) return;
	const origins = lines.map((): HashlineLineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return;
	}
	fileLines.splice(0, 0, ...lines);
	lineOrigins.splice(0, 0, ...origins);
}

function insertAtEnd(fileLines: string[], lineOrigins: HashlineLineOrigin[], lines: string[]): number | undefined {
	if (lines.length === 0) return undefined;
	const origins = lines.map((): HashlineLineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return 1;
	}
	const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
	const insertIndex = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
	fileLines.splice(insertIndex, 0, ...lines);
	lineOrigins.splice(insertIndex, 0, ...origins);
	return insertIndex + 1;
}

/** Bucket edits by the line they target so we can apply each line's group in one splice. */
function bucketAnchorEditsByLine(edits: IndexedEdit[]): Map<number, IndexedEdit[]> {
	const byLine = new Map<number, IndexedEdit[]>();
	for (const entry of edits) {
		const line =
			entry.edit.kind === "delete"
				? entry.edit.anchor.line
				: entry.edit.cursor.kind === "before_anchor"
					? entry.edit.cursor.anchor.line
					: 0;
		const bucket = byLine.get(line);
		if (bucket) bucket.push(entry);
		else byLine.set(line, [entry]);
	}
	return byLine;
}

export function applyHashlineEdits(text: string, edits: HashlineEdit[]): HashlineApplyResult {
	if (edits.length === 0) return { lines: text, firstChangedLine: undefined };

	const fileLines = text.split("\n");
	const lineOrigins: HashlineLineOrigin[] = fileLines.map(() => "original");
	const warnings: string[] = [];

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const mismatches = validateHashlineAnchors(edits, fileLines, warnings);
	if (mismatches.length > 0) throw new HashlineMismatchError(mismatches, fileLines);

	// Normalize after_anchor inserts to before_anchor of the next line, or EOF
	// when the anchor is the final line. This keeps the bucketing logic below
	// (which only knows about before_anchor / bof / eof) untouched.
	for (const edit of edits) {
		if (edit.kind !== "insert" || edit.cursor.kind !== "after_anchor") continue;
		const anchorLine = edit.cursor.anchor.line;
		if (anchorLine >= fileLines.length) {
			edit.cursor = { kind: "eof" };
			continue;
		}
		const nextLineNum = anchorLine + 1;
		const nextContent = fileLines[nextLineNum - 1] ?? "";
		edit.cursor = {
			kind: "before_anchor",
			anchor: { line: nextLineNum, hash: computeLineHash(nextLineNum, nextContent) },
		};
	}

	// Partition edits into BOF, EOF, and anchor-targeted buckets.
	const bofLines: string[] = [];
	const eofLines: string[] = [];
	const anchorEdits: IndexedEdit[] = [];
	edits.forEach((edit, idx) => {
		if (edit.kind === "insert" && edit.cursor.kind === "bof") {
			bofLines.push(edit.text);
		} else if (edit.kind === "insert" && edit.cursor.kind === "eof") {
			eofLines.push(edit.text);
		} else {
			anchorEdits.push({ edit, idx });
		}
	});

	// Apply per-line buckets bottom-up so earlier indices stay valid.
	const byLine = bucketAnchorEditsByLine(anchorEdits);
	for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
		const bucket = byLine.get(line);
		if (!bucket) continue;
		bucket.sort((a, b) => a.idx - b.idx);

		const idx = line - 1;
		const currentLine = fileLines[idx] ?? "";
		const beforeLines: string[] = [];
		let deleteLine = false;

		for (const { edit } of bucket) {
			if (edit.kind === "insert") beforeLines.push(edit.text);
			else deleteLine = true;
		}
		if (beforeLines.length === 0 && !deleteLine) continue;

		const replacement = deleteLine ? beforeLines : [...beforeLines, currentLine];
		const origins = replacement.map((): HashlineLineOrigin => (deleteLine ? "replacement" : "insert"));
		if (!deleteLine) origins[origins.length - 1] = lineOrigins[idx] ?? "original";

		fileLines.splice(idx, 1, ...replacement);
		lineOrigins.splice(idx, 1, ...origins);
		trackFirstChanged(line);
	}

	if (bofLines.length > 0) {
		insertAtStart(fileLines, lineOrigins, bofLines);
		trackFirstChanged(1);
	}
	const eofChangedLine = insertAtEnd(fileLines, lineOrigins, eofLines);
	if (eofChangedLine !== undefined) trackFirstChanged(eofChangedLine);

	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

// ───────────────────────────────────────────────────────────────────────────
// 12. Input splitting
//
// Hashline input may contain multiple file sections, each introduced by a
// header line of the form `@<path>`. If the input contains recognizable ops
// but no header, we synthesize one from the caller-supplied `path` option.
// ───────────────────────────────────────────────────────────────────────────

interface HashlineInputSection {
	path: string;
	diff: string;
}

function unquoteHashlinePath(pathText: string): string {
	if (pathText.length < 2) return pathText;
	const first = pathText[0];
	const last = pathText[pathText.length - 1];
	if ((first === '"' || first === "'") && first === last) return pathText.slice(1, -1);
	return pathText;
}

function normalizeHashlinePath(rawPath: string, cwd?: string): string {
	const unquoted = unquoteHashlinePath(rawPath.trim());
	if (!cwd || !path.isAbsolute(unquoted)) return unquoted;
	const relative = path.relative(path.resolve(cwd), path.resolve(unquoted));
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	return isWithinCwd ? relative || "." : unquoted;
}

function parseHashlineHeaderLine(line: string, cwd?: string): HashlineInputSection | null {
	const trimmed = line.trimEnd();
	if (trimmed === FILE_HEADER_PREFIX) {
		throw new Error(`Input header "${FILE_HEADER_PREFIX}" is empty; provide a file path.`);
	}
	if (!trimmed.startsWith(FILE_HEADER_PREFIX)) return null;
	const parsedPath = normalizeHashlinePath(trimmed.slice(1), cwd);
	if (parsedPath.length === 0) {
		throw new Error(`Input header "${FILE_HEADER_PREFIX}" is empty; provide a file path.`);
	}
	return { path: parsedPath, diff: "" };
}

function stripLeadingBlankLines(input: string): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const lines = stripped.split("\n");
	while (lines.length > 0 && lines[0].replace(/\r$/, "").trim().length === 0) lines.shift();
	return lines.join("\n");
}

function containsRecognizableHashlineOperations(input: string): boolean {
	for (const rawLine of input.split("\n")) {
		const line = stripTrailingCarriageReturn(rawLine);
		if (/^[+<=-]\s+/.test(line) || line.startsWith(HASHLINE_CONTENT_SEPARATOR)) return true;
	}
	return false;
}

function normalizeFallbackInput(input: string, options: SplitHashlineOptions): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const hasExplicitHeader = stripped
		.split("\n")
		.some(rawLine => parseHashlineHeaderLine(stripTrailingCarriageReturn(rawLine), options.cwd) !== null);
	if (hasExplicitHeader) return input;

	if (!options.path || !containsRecognizableHashlineOperations(input)) return input;
	const fallbackPath = normalizeHashlinePath(options.path, options.cwd);
	if (fallbackPath.length === 0) return input;
	return `${FILE_HEADER_PREFIX} ${fallbackPath}\n${input}`;
}

export function splitHashlineInput(input: string, options: SplitHashlineOptions = {}): { path: string; diff: string } {
	const [section] = splitHashlineInputs(input, options);
	return section;
}

export function splitHashlineInputs(input: string, options: SplitHashlineOptions = {}): HashlineInputSection[] {
	const stripped = stripLeadingBlankLines(normalizeFallbackInput(input, options));
	const lines = stripped.split("\n");
	const firstLine = stripTrailingCarriageReturn(lines[0] ?? "");

	if (parseHashlineHeaderLine(firstLine, options.cwd) === null) {
		const preview = JSON.stringify(firstLine.slice(0, 120));
		throw new Error(
			`input must begin with "@PATH" on the first non-blank line; got: ${preview}. ` +
				`Example: "@src/foo.ts" then edit ops.`,
		);
	}

	const sections: HashlineInputSection[] = [];
	let currentPath = "";
	let currentLines: string[] = [];

	const flush = () => {
		if (currentPath.length === 0) return;
		sections.push({ path: currentPath, diff: currentLines.join("\n") });
		currentLines = [];
	};

	for (const rawLine of lines) {
		const line = stripTrailingCarriageReturn(rawLine);
		const header = parseHashlineHeaderLine(line, options.cwd);
		if (header !== null) {
			flush();
			currentPath = header.path;
			currentLines = [];
		} else {
			currentLines.push(rawLine);
		}
	}
	flush();
	return sections;
}

// ───────────────────────────────────────────────────────────────────────────
// 13. Diff computation (for streaming preview)
// ───────────────────────────────────────────────────────────────────────────

async function readHashlineFileText(file: { text(): Promise<string> }, pathText: string): Promise<string> {
	try {
		return await file.text();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${pathText}`);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${pathText}`);
	}
}

export async function computeHashlineDiff(
	input: { input: string; path?: string },
	cwd: string,
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const sections = splitHashlineInputs(input.input, { cwd, path: input.path });
		if (sections.length !== 1) {
			return { error: "Streaming diff preview supports exactly one hashline section." };
		}
		const [section] = sections;

		const absolutePath = resolveToCwd(section.path, cwd);
		const rawContent = await readHashlineFileText(Bun.file(absolutePath), section.path);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		const result = applyHashlineEdits(normalized, parseHashline(section.diff));
		if (normalized === result.lines) return { error: `No changes would be made to ${section.path}.` };
		return generateDiffString(normalized, result.lines);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// ───────────────────────────────────────────────────────────────────────────
// 14. Execution
// ───────────────────────────────────────────────────────────────────────────

interface ReadHashlineFileResult {
	exists: boolean;
	rawContent: string;
}

async function readHashlineFile(absolutePath: string): Promise<ReadHashlineFileResult> {
	try {
		return { exists: true, rawContent: await Bun.file(absolutePath).text() };
	} catch (error) {
		if (isEnoent(error)) return { exists: false, rawContent: "" };
		throw error;
	}
}

function hasAnchorScopedEdit(edits: HashlineEdit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function formatNoChangeDiagnostic(pathText: string): string {
	return `Edits to ${pathText} resulted in no changes being made.`;
}

function getTextContent(result: AgentToolResult<EditToolDetails>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function getEditDetails(result: AgentToolResult<EditToolDetails>): EditToolDetails {
	return result.details ?? { diff: "" };
}

/**
 * Run all the front-end checks (notebook guard, parse, plan-mode check, file
 * load, edit application) without writing. Used to fail fast before applying
 * any changes in a multi-section batch.
 */
async function preflightHashlineSection(options: ExecuteHashlineSingleOptions & HashlineInputSection): Promise<void> {
	const { session, path: sectionPath, diff } = options;

	const absolutePath = resolvePlanPath(session, sectionPath);
	const { edits } = parseHashlineWithWarnings(diff);
	enforcePlanModeWrite(session, sectionPath, { op: "update" });

	const source = await readHashlineFile(absolutePath);
	if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${sectionPath}`);
	if (source.exists) assertEditableFileContent(source.rawContent, sectionPath);

	const { text } = stripBom(source.rawContent);
	const normalized = normalizeToLF(text);
	const result = applyHashlineEdits(normalized, edits);
	if (normalized === result.lines) throw new Error(formatNoChangeDiagnostic(sectionPath));
}

async function executeHashlineSection(
	options: ExecuteHashlineSingleOptions & HashlineInputSection,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const {
		session,
		path: sourcePath,
		diff,
		signal,
		batchRequest,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;

	const absolutePath = resolvePlanPath(session, sourcePath);
	const { edits, warnings: parseWarnings } = parseHashlineWithWarnings(diff);
	enforcePlanModeWrite(session, sourcePath, { op: "update" });

	const source = await readHashlineFile(absolutePath);
	if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${sourcePath}`);
	if (source.exists) assertEditableFileContent(source.rawContent, sourcePath);

	const { bom, text } = stripBom(source.rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);
	const result = applyHashlineEdits(originalNormalized, edits);

	if (originalNormalized === result.lines) {
		return {
			content: [{ type: "text", text: formatNoChangeDiagnostic(sourcePath) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
	}

	const finalContent = bom + restoreLineEndings(result.lines, originalEnding);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);

	const diffResult = generateDiffString(originalNormalized, result.lines);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);

	const warnings = [...parseWarnings, ...(result.warnings ?? [])];
	const warningsBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const headline = preview.preview
		? `${sourcePath}:`
		: source.exists
			? `Updated ${sourcePath}`
			: `Created ${sourcePath}`;

	return {
		content: [{ type: "text", text: `${headline}${previewBlock}${warningsBlock}` }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
			diagnostics,
			op: source.exists ? "update" : "create",
			meta,
		},
	};
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const sections = splitHashlineInputs(options.input, { cwd: options.session.cwd, path: options.path });

	// Fast path: a single section needs no preflight pass.
	if (sections.length === 1) return executeHashlineSection({ ...options, ...sections[0] });

	// Multi-section: validate everything up front so we don't apply a partial batch.
	for (const section of sections) await preflightHashlineSection({ ...options, ...section });

	const results = [];
	for (const section of sections) {
		results.push({ path: section.path, result: await executeHashlineSection({ ...options, ...section }) });
	}

	return {
		content: [{ type: "text", text: results.map(({ result }) => getTextContent(result)).join("\n\n") }],
		details: {
			diff: results.map(({ result }) => getEditDetails(result).diff).join("\n"),
			perFileResults: results.map(({ path: resultPath, result }) => {
				const details = getEditDetails(result);
				return {
					path: resultPath,
					diff: details.diff,
					firstChangedLine: details.firstChangedLine,
					diagnostics: details.diagnostics,
					op: details.op,
					move: details.move,
					meta: details.meta,
				};
			}),
		},
	};
}
