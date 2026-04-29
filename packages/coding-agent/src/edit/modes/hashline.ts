/**
 * Hashline edit mode — a line-addressable edit format using text hashes.
 *
 * Each line in a file is identified by its 1-indexed line number and a short
 * BPE-bigram hash derived from the normalized line text (xxHash32 mod 647,
 * mapped through HASHLINE_BIGRAMS).
 * The combined `LINE+ID` reference acts as both an address and a staleness check:
 * if the file has changed since the caller last read it, hash mismatches are caught
 * before any mutation occurs.
 *
 * Displayed format: `LINE+ID|TEXT`
 * Reference format: `"LINE+ID"` (e.g. `"1ab"`)
 *
 * In tool JSON, each edit's `content` is `string[]` (one string per logical line) or
 * `null` to delete the targeted range.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { BunFile } from "bun";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { formatCodeFrameLine } from "../../tools/render-utils";
import { generateDiffString } from "../diff";
import { computeLineHash, formatHashLine, HASHLINE_BIGRAM_RE_SRC, HASHLINE_CONTENT_SEPARATOR } from "../line-hash";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import type { EditToolDetails, LspBatchRequest } from "../renderer";

export interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

export type Anchor = { line: number; hash: string; contentHint?: string };
export type HashlineEdit =
	| { op: "replace_line"; pos: Anchor; lines: string[] }
	| { op: "replace_range"; pos: Anchor; end: Anchor; lines: string[] }
	| { op: "append_at"; pos: Anchor; lines: string[] }
	| { op: "prepend_at"; pos: Anchor; lines: string[] }
	| { op: "append_file"; lines: string[] }
	| { op: "prepend_file"; lines: string[] };

// Tight prefix matchers for the new format `LINE+ID|content`. The pipe is the
// canonical separator; legacy reads using `:` are tolerated for back-compat.
// Line-number digits are mandatory.
// Accept both `|` (canonical) and `:` (legacy) so re-reads of older outputs still parse.
const HASHLINE_CONTENT_SEPARATOR_RE = "[:|]";
const HASHLINE_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*(?:\\+\\s*)?\\d+${HASHLINE_BIGRAM_RE_SRC}${HASHLINE_CONTENT_SEPARATOR_RE}`,
);
const HASHLINE_PREFIX_PLUS_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*\\+\\s*\\d+${HASHLINE_BIGRAM_RE_SRC}${HASHLINE_CONTENT_SEPARATOR_RE}`,
);
const DIFF_PLUS_RE = /^[+](?![+])/;
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bsel=L?\d+/;

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

function stripLeadingHashlinePrefixes(line: string): string {
	let result = line;
	let prev: string;
	do {
		prev = result;
		result = result.replace(HASHLINE_PREFIX_RE, "");
	} while (result !== prev);
	return result;
}

function _filterTruncationNotices(lines: string[]): string[] {
	return lines.filter(line => !READ_TRUNCATION_NOTICE_RE.test(line));
}

export function stripNewLinePrefixes(lines: string[]): string[] {
	const { nonEmpty, hashPrefixCount, diffPlusHashPrefixCount, diffPlusCount } = collectLinePrefixStats(lines);
	if (nonEmpty === 0) return lines;

	const stripHash = hashPrefixCount > 0 && hashPrefixCount === nonEmpty;
	const stripPlus =
		!stripHash && diffPlusHashPrefixCount === 0 && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;
	if (!stripHash && !stripPlus && diffPlusHashPrefixCount === 0) return lines;

	const mapped = lines
		.filter(line => !READ_TRUNCATION_NOTICE_RE.test(line))
		.map(line => {
			if (stripHash) return stripLeadingHashlinePrefixes(line);
			if (stripPlus) return line.replace(DIFF_PLUS_RE, "");
			if (diffPlusHashPrefixCount > 0 && HASHLINE_PREFIX_PLUS_RE.test(line)) {
				return line.replace(HASHLINE_PREFIX_RE, "");
			}
			return line;
		});
	return mapped;
}

export function stripHashlinePrefixes(lines: string[]): string[] {
	const { nonEmpty, hashPrefixCount } = collectLinePrefixStats(lines);
	if (nonEmpty === 0) return lines;
	if (hashPrefixCount !== nonEmpty) return lines;
	return lines.filter(line => !READ_TRUNCATION_NOTICE_RE.test(line)).map(line => stripLeadingHashlinePrefixes(line));
}

const linesSchema = Type.Union([Type.Array(Type.String()), Type.Null()]);

const locSchema = Type.Union(
	[
		Type.Literal("append"),
		Type.Literal("prepend"),
		Type.Object({ append: Type.String({ description: "anchor" }) }),
		Type.Object({ prepend: Type.String({ description: "anchor" }) }),
		Type.Object({
			range: Type.Object({
				pos: Type.String({ description: "first line to edit (inclusive)" }),
				end: Type.String({ description: "last line to edit (inclusive)" }),
			}),
		}),
	],
	{ description: "insert location" },
);

export const hashlineEditSchema = Type.Object(
	{
		loc: Type.Optional(locSchema),
		content: Type.Optional(linesSchema),
	},
	{ additionalProperties: false },
);

export const hashlineEditParamsSchema = Type.Object(
	{
		path: Type.String({ description: "file path for edits" }),
		edits: Type.Array(hashlineEditSchema, { description: "edits" }),
	},
	{ additionalProperties: false },
);

export type HashlineToolEdit = Static<typeof hashlineEditSchema>;
export type HashlineParams = Static<typeof hashlineEditParamsSchema>;

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	path: string;
	edits: HashlineToolEdit[];
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

/**
 * Normalize line payloads for apply: strip read/grep line prefixes. The tool schema
 * supplies `string[]` (one element per line). `null` / `undefined` yield `[]`.
 * A single multiline `string` is still split on `\n` for the same normalization path.
 */
export function hashlineParseText(edit: string[] | string | null | undefined): string[] {
	if (edit == null) return [];
	if (typeof edit === "string") {
		const normalizedEdit = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
		edit = normalizedEdit.replaceAll("\r", "").split("\n");
	}
	return stripNewLinePrefixes(edit);
}

function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	return edits.map(resolveEditAnchor);
}

type HashlineEditInput = HashlineToolEdit | HashlineEdit;

function resolveHashlineEditsForDiff(edits: HashlineEditInput[]): HashlineEdit[] {
	return edits.map((edit, editIndex) => {
		if (!edit || typeof edit !== "object") {
			throw new Error(`Invalid hashline edit at index ${editIndex}: expected object.`);
		}

		if ("op" in edit) {
			return edit;
		}

		if ("loc" in edit) {
			return resolveEditAnchor(edit);
		}

		throw new Error(`Invalid hashline edit at index ${editIndex}: expected op/loc payload.`);
	});
}

export function formatFullAnchorRequirement(raw?: string): string {
	const suffix = typeof raw === "string" ? raw.trim() : "";
	const hashOnlyHint = /^[A-Za-z]{2}$/.test(suffix)
		? ` It looks like you supplied only the 2-letter suffix (${JSON.stringify(suffix)}). Copy the full anchor exactly as shown (for example, "160${suffix}").`
		: "";
	const received = raw === undefined ? "" : ` Received ${JSON.stringify(raw)}.`;
	return `the full anchor exactly as shown by read/grep (line number + 2-letter suffix, for example "160sr")${received}${hashOnlyHint}`;
}

function tryParseTag(raw: string): Anchor | undefined {
	try {
		return parseTag(raw);
	} catch {
		return undefined;
	}
}

function requireParsedAnchor(raw: string, op: "append" | "prepend"): Anchor {
	const anchor = tryParseTag(raw);
	if (!anchor) throw new Error(`${op} requires ${formatFullAnchorRequirement(raw)}.`);
	return anchor;
}

function requireParsedRange(range: { pos: string; end: string }): { pos: Anchor; end: Anchor } {
	const pos = tryParseTag(range.pos);
	const end = tryParseTag(range.end);
	if (!pos || !end) {
		const invalid = [
			!pos ? `pos=${JSON.stringify(range.pos)}` : null,
			!end ? `end=${JSON.stringify(range.end)}` : null,
		]
			.filter(Boolean)
			.join(", ");
		throw new Error(
			`range requires valid pos and end anchors. Use ${formatFullAnchorRequirement()}. Invalid: ${invalid}.`,
		);
	}
	return { pos, end };
}

function resolveEditAnchor(edit: HashlineToolEdit): HashlineEdit {
	const lines = hashlineParseText(edit.content);
	const loc = edit.loc;

	if (loc === "append") {
		return { op: "append_file", lines };
	}

	if (loc === "prepend") {
		return { op: "prepend_file", lines };
	}

	if (typeof loc !== "object") {
		throw new Error(`Invalid loc value: ${JSON.stringify(loc)}`);
	}

	if ("append" in loc) {
		return { op: "append_at", pos: requireParsedAnchor(loc.append, "append"), lines };
	}

	if ("prepend" in loc) {
		return { op: "prepend_at", pos: requireParsedAnchor(loc.prepend, "prepend"), lines };
	}

	if ("range" in loc) {
		const { pos, end } = requireParsedRange(loc.range);
		return { op: "replace_range", pos, end, lines };
	}

	throw new Error("Unknown loc shape. Expected append, prepend, or range.");
}

// ═══════════════════════════════════════════════════════════════════════════
// Hashline streaming formatter
// ═══════════════════════════════════════════════════════════════════════════

export interface HashlineStreamOptions {
	/** First line number to use when formatting (1-indexed). */
	startLine?: number;
	/** Maximum formatted lines per yielded chunk (default: 200). */
	maxChunkLines?: number;
	/** Maximum UTF-8 bytes per yielded chunk (default: 64 KiB). */
	maxChunkBytes?: number;
}

interface ResolvedHashlineStreamOptions {
	startLine: number;
	maxChunkLines: number;
	maxChunkBytes: number;
}

interface HashlineChunkEmitter {
	pushLine: (line: string) => string[];
	flush: () => string | undefined;
}

function resolveHashlineStreamOptions(options: HashlineStreamOptions): ResolvedHashlineStreamOptions {
	return {
		startLine: options.startLine ?? 1,
		maxChunkLines: options.maxChunkLines ?? 200,
		maxChunkBytes: options.maxChunkBytes ?? 64 * 1024,
	};
}

function createHashlineChunkEmitter(
	options: ResolvedHashlineStreamOptions,
	formatLine = formatHashLine,
): HashlineChunkEmitter {
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
		const formatted = formatLine(lineNumber, line);
		lineNumber++;

		const chunksToYield: string[] = [];
		const sepBytes = outLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(formatted, "utf-8");

		if (
			outLines.length > 0 &&
			(outLines.length >= options.maxChunkLines || outBytes + sepBytes + lineBytes > options.maxChunkBytes)
		) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		outLines.push(formatted);
		outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

		if (outLines.length >= options.maxChunkLines || outBytes >= options.maxChunkBytes) {
			const flushed = flush();
			if (flushed) chunksToYield.push(flushed);
		}

		return chunksToYield;
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

/**
 * Stream hashline-formatted output from a UTF-8 byte source.
 *
 * This is intended for large files where callers want incremental output
 * (e.g. while reading from a file handle) rather than allocating a single
 * large string.
 */
export async function* streamHashLinesFromUtf8(
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const resolvedOptions = resolveHashlineStreamOptions(options);
	const decoder = new TextDecoder("utf-8");
	const chunks = isReadableStream(source) ? bytesFromReadableStream(source) : source;
	let pending = "";
	let sawAnyText = false;
	let endedWithNewline = false;
	const emitter = createHashlineChunkEmitter(resolvedOptions);

	const consumeText = (text: string): string[] => {
		if (text.length === 0) return [];
		sawAnyText = true;
		pending += text;
		const chunksToYield: string[] = [];
		while (true) {
			const idx = pending.indexOf("\n");
			if (idx === -1) break;
			const line = pending.slice(0, idx);
			pending = pending.slice(idx + 1);
			endedWithNewline = true;
			chunksToYield.push(...emitter.pushLine(line));
		}
		if (pending.length > 0) endedWithNewline = false;
		return chunksToYield;
	};
	for await (const chunk of chunks) {
		for (const out of consumeText(decoder.decode(chunk, { stream: true }))) {
			yield out;
		}
	}

	for (const out of consumeText(decoder.decode())) {
		yield out;
	}
	if (!sawAnyText) {
		// Mirror `"".split("\n")` behavior: one empty line.
		for (const out of emitter.pushLine("")) {
			yield out;
		}
	} else if (pending.length > 0 || endedWithNewline) {
		// Emit the final line (may be empty if the file ended with a newline).
		for (const out of emitter.pushLine(pending)) {
			yield out;
		}
	}

	const last = emitter.flush();
	if (last) yield last;
}

/**
 * Stream hashline-formatted output from an (async) iterable of lines.
 *
 * Each yielded chunk is a `\n`-joined string of one or more formatted lines.
 */
export async function* streamHashLinesFromLines(
	lines: Iterable<string> | AsyncIterable<string>,
	options: HashlineStreamOptions = {},
): AsyncGenerator<string> {
	const resolvedOptions = resolveHashlineStreamOptions(options);
	const emitter = createHashlineChunkEmitter(resolvedOptions);
	let sawAnyLine = false;

	const asyncIterator = (lines as AsyncIterable<string>)[Symbol.asyncIterator];
	if (typeof asyncIterator === "function") {
		for await (const line of lines as AsyncIterable<string>) {
			sawAnyLine = true;
			for (const out of emitter.pushLine(line)) {
				yield out;
			}
		}
	} else {
		for (const line of lines as Iterable<string>) {
			sawAnyLine = true;
			for (const out of emitter.pushLine(line)) {
				yield out;
			}
		}
	}
	if (!sawAnyLine) {
		// Mirror `"".split("\n")` behavior: one empty line.
		for (const out of emitter.pushLine("")) {
			yield out;
		}
	}

	const last = emitter.flush();
	if (last) yield last;
}

/**
 * Parse a line reference string like `"5th"` into structured form.
 *
 * @throws Error if the format is invalid (not `NUMBERBIGRAM`)
 */
export function parseTag(ref: string): { line: number; hash: string } {
	// Captures:
	//  1. optional leading ">+-" markers and whitespace
	//  2. line number (1+ digits)
	//  3. hash (one BPE bigram from HASHLINE_BIGRAMS) directly adjacent (no separator)
	const match = ref.match(new RegExp(`^\\s*[>+-]*\\s*(\\d+)(${HASHLINE_BIGRAM_RE_SRC})`));
	if (!match) {
		throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}
	return { line, hash: match[2] };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hash Mismatch Error
// ═══════════════════════════════════════════════════════════════════════════

/** Number of context lines shown above/below each mismatched line */
const MISMATCH_CONTEXT = 2;

/**
 * Error thrown when one or more hashline references have stale hashes.
 *
 * Displays grep-style output with `*` marker on mismatched lines and a leading space on
 * surrounding context, showing the correct `LINE+ID` so the caller can fix all refs at once.
 */
export class HashlineMismatchError extends Error {
	readonly remaps: ReadonlyMap<string, string>;
	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
		const remaps = new Map<string, string>();
		for (const m of mismatches) {
			const actual = computeLineHash(m.line, fileLines[m.line - 1]);
			remaps.set(`${m.line}${m.expected}`, `${m.line}${actual}`);
		}
		this.remaps = remaps;
	}

	/**
	 * User-visible variant of {@link formatMessage} — omits the bigram fingerprint
	 * and uses a `│` gutter so TUI rendering is clean. The model still receives
	 * the full `LINE+ID|content` form via {@link Error.message}.
	 */
	get displayMessage(): string {
		return HashlineMismatchError.formatDisplayMessage(this.mismatches, this.fileLines);
	}

	static formatDisplayMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Set<number>();
		for (const m of mismatches) mismatchSet.add(m.line);

		const displayLines = new Set<number>();
		for (const m of mismatches) {
			const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
			const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
			for (let i = lo; i <= hi; i++) displayLines.add(i);
		}

		const sorted = [...displayLines].sort((a, b) => a - b);
		const out: string[] = [
			`Edit rejected: ${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since the last read (marked *).`,
			"The edit was NOT applied, please use the updated file content shown below, and issue another edit tool-call.",
			"",
		];

		const lineNumberWidth = sorted.reduce((width, lineNum) => Math.max(width, String(lineNum).length), 0);
		let prevLine = -1;
		for (const lineNum of sorted) {
			if (prevLine !== -1 && lineNum > prevLine + 1) out.push("...");
			prevLine = lineNum;
			const text = fileLines[lineNum - 1];
			const marker = mismatchSet.has(lineNum) ? "*" : " ";
			out.push(formatCodeFrameLine(marker, lineNum, text ?? "", lineNumberWidth));
		}
		return out.join("\n");
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Map<number, HashMismatch>();
		for (const m of mismatches) {
			mismatchSet.set(m.line, m);
		}

		// Collect line ranges to display (mismatch lines + context)
		const displayLines = new Set<number>();
		for (const m of mismatches) {
			const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
			const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
			for (let i = lo; i <= hi; i++) {
				displayLines.add(i);
			}
		}

		const sorted = [...displayLines].sort((a, b) => a - b);
		const lines: string[] = [];

		lines.push(
			`Edit rejected: ${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since the last read (marked *).`,
			"The edit was NOT applied, please use the updated file content shown below, and issue another edit tool-call.",
		);
		lines.push("");

		let prevLine = -1;
		for (const lineNum of sorted) {
			// Gap separator between non-contiguous regions
			if (prevLine !== -1 && lineNum > prevLine + 1) {
				lines.push("...");
			}
			prevLine = lineNum;

			const text = fileLines[lineNum - 1];
			const hash = computeLineHash(lineNum, text);
			const prefix = `${lineNum}${hash}`;

			if (mismatchSet.has(lineNum)) {
				lines.push(`*${prefix}|${text}`);
			} else {
				lines.push(` ${prefix}|${text}`);
			}
		}
		return lines.join("\n");
	}
}

/**
 * Validate that a line reference points to an existing line with a matching hash.
 *
 * @param ref - Parsed line reference (1-indexed line number + expected hash)
 * @param fileLines - Array of file lines (0-indexed)
 * @throws HashlineMismatchError if the hash doesn't match (includes correct hashes in context)
 * @throws Error if the line is out of range
 */
export function validateLineRef(ref: { line: number; hash: string }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
	if (actualHash !== ref.hash) {
		throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
	}
}

/**
 * Default search window for {@link tryRebaseAnchor} (lines on each side of the requested anchor).
 */
export const ANCHOR_REBASE_WINDOW = 2;

/**
 * Look for the requested hash within ±`window` lines of `anchor.line`.
 *
 * Returns the new line number when exactly one nearby line matches the hash;
 * otherwise `null` (genuine mismatch or ambiguous). The caller is expected to
 * mutate `anchor.line` in place and surface a warning so the model knows the
 * edit was retargeted.
 *
 * The exact-position match (anchor.line itself) is intentionally skipped: the
 * caller has already determined the requested line's hash does not match.
 */
export function tryRebaseAnchor(
	anchor: { line: number; hash: string },
	fileLines: string[],
	window: number = ANCHOR_REBASE_WINDOW,
): number | null {
	const lo = Math.max(1, anchor.line - window);
	const hi = Math.min(fileLines.length, anchor.line + window);
	let found: number | null = null;
	for (let line = lo; line <= hi; line++) {
		if (line === anchor.line) continue;
		if (computeLineHash(line, fileLines[line - 1]) !== anchor.hash) continue;
		if (found !== null) return null; // ambiguous: more than one match in window
		found = line;
	}
	return found;
}

function ensureHashlineEditHasContent(edit: HashlineEdit): void {
	if (edit.lines.length === 0) {
		edit.lines = [""];
	}
}

function collectBoundaryDuplicationWarning(edit: HashlineEdit, originalFileLines: string[], warnings: string[]): void {
	let endLine: number;
	switch (edit.op) {
		case "replace_line":
			endLine = edit.pos.line;
			break;
		case "replace_range":
			endLine = edit.end.line;
			break;
		default:
			return;
	}

	if (edit.lines.length === 0) return;
	const nextSurvivingIdx = endLine;
	if (nextSurvivingIdx >= originalFileLines.length) return;
	const nextSurvivingLine = originalFileLines[nextSurvivingIdx];
	const lastInsertedLine = edit.lines[edit.lines.length - 1];
	const trimmedNext = nextSurvivingLine.trim();
	const trimmedLast = lastInsertedLine.trim();
	if (trimmedLast.length > 0 && trimmedLast === trimmedNext) {
		const tag = formatHashLine(endLine + 1, nextSurvivingLine);
		warnings.push(
			`Possible boundary duplication: your last replacement line \`${trimmedLast}\` is identical to the next surviving line ${tag}. ` +
				`If you meant to replace the entire block, set \`end\` to ${tag} instead.`,
		);
	}
}

function dedupeHashlineEdits(edits: HashlineEdit[]): void {
	const seenEditKeys = new Map<string, number>();
	const dedupIndices = new Set<number>();
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		let lineKey: string;
		switch (edit.op) {
			case "replace_line":
				lineKey = `s:${edit.pos.line}`;
				break;
			case "replace_range":
				lineKey = `r:${edit.pos.line}:${edit.end.line}`;
				break;
			case "append_at":
				lineKey = `i:${edit.pos.line}`;
				break;
			case "prepend_at":
				lineKey = `ib:${edit.pos.line}`;
				break;
			case "append_file":
				lineKey = "ieof";
				break;
			case "prepend_file":
				lineKey = "ibef";
				break;
		}
		const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
		if (seenEditKeys.has(dstKey)) {
			dedupIndices.add(i);
		} else {
			seenEditKeys.set(dstKey, i);
		}
	}
	if (dedupIndices.size === 0) return;
	for (let i = edits.length - 1; i >= 0; i--) {
		if (dedupIndices.has(i)) edits.splice(i, 1);
	}
}

function getHashlineEditSortKey(edit: HashlineEdit, fileLineCount: number): { sortLine: number; precedence: number } {
	switch (edit.op) {
		case "replace_line":
			return { sortLine: edit.pos.line, precedence: 0 };
		case "replace_range":
			return { sortLine: edit.end.line, precedence: 0 };
		case "append_at":
			return { sortLine: edit.pos.line, precedence: 1 };
		case "prepend_at":
			return { sortLine: edit.pos.line, precedence: 2 };
		case "append_file":
			return { sortLine: fileLineCount + 1, precedence: 1 };
		case "prepend_file":
			return { sortLine: 0, precedence: 2 };
	}
}

function applyHashlineEditToLines(
	edit: HashlineEdit,
	fileLines: string[],
	originalFileLines: string[],
	editIndex: number,
	noopEdits: Array<{ editIndex: number; loc: string; current: string }>,
	trackFirstChanged: (line: number) => void,
): void {
	switch (edit.op) {
		case "replace_line": {
			const origLines = originalFileLines.slice(edit.pos.line - 1, edit.pos.line);
			const newLines = edit.lines;
			if (origLines.length === newLines.length && origLines.every((line, i) => line === newLines[i])) {
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}`,
					current: origLines.join("\n"),
				});
				break;
			}
			fileLines.splice(edit.pos.line - 1, 1, ...newLines);
			trackFirstChanged(edit.pos.line);
			break;
		}
		case "replace_range": {
			const count = edit.end.line - edit.pos.line + 1;
			const origRange = originalFileLines.slice(edit.pos.line - 1, edit.pos.line - 1 + count);
			if (count === edit.lines.length && origRange.every((line, i) => line === edit.lines[i])) {
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}-${edit.end.line}${edit.end.hash}`,
					current: origRange.join("\n"),
				});
				break;
			}
			fileLines.splice(edit.pos.line - 1, count, ...edit.lines);
			trackFirstChanged(edit.pos.line);
			break;
		}
		case "append_at": {
			const inserted = edit.lines;
			if (inserted.length === 0) {
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}`,
					current: originalFileLines[edit.pos.line - 1],
				});
				break;
			}
			fileLines.splice(edit.pos.line, 0, ...inserted);
			trackFirstChanged(edit.pos.line + 1);
			break;
		}
		case "prepend_at": {
			const inserted = edit.lines;
			if (inserted.length === 0) {
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}`,
					current: originalFileLines[edit.pos.line - 1],
				});
				break;
			}
			fileLines.splice(edit.pos.line - 1, 0, ...inserted);
			trackFirstChanged(edit.pos.line);
			break;
		}
		case "append_file": {
			const inserted = edit.lines;
			if (inserted.length === 0) {
				noopEdits.push({ editIndex, loc: "EOF", current: "" });
				break;
			}
			if (fileLines.length === 1 && fileLines[0] === "") {
				fileLines.splice(0, 1, ...inserted);
				trackFirstChanged(1);
			} else {
				fileLines.splice(fileLines.length, 0, ...inserted);
				trackFirstChanged(fileLines.length - inserted.length + 1);
			}
			break;
		}
		case "prepend_file": {
			const inserted = edit.lines;
			if (inserted.length === 0) {
				noopEdits.push({ editIndex, loc: "BOF", current: "" });
				break;
			}
			if (fileLines.length === 1 && fileLines[0] === "") {
				fileLines.splice(0, 1, ...inserted);
			} else {
				fileLines.splice(0, 0, ...inserted);
			}
			trackFirstChanged(1);
			break;
		}
	}
}

function buildHashlineEditResult(params: {
	fileLines: string[];
	firstChangedLine: number | undefined;
	warnings: string[];
	noopEdits: Array<{ editIndex: number; loc: string; current: string }>;
}): {
	lines: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
} {
	const { fileLines, firstChangedLine, warnings, noopEdits } = params;
	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
		...(noopEdits.length > 0 ? { noopEdits } : {}),
	};
}

function validateHashlineEditRefs(edits: HashlineEdit[], fileLines: string[], warnings: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	for (const edit of edits) {
		switch (edit.op) {
			case "replace_line":
				validateHashlineRef(edit.pos);
				break;
			case "replace_range":
				validateHashlineRef(edit.pos);
				validateHashlineRef(edit.end);
				if (edit.pos.line > edit.end.line) {
					throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`);
				}
				break;
			case "append_at":
			case "prepend_at":
				validateHashlineRef(edit.pos);
				ensureHashlineEditHasContent(edit);
				break;
			case "append_file":
			case "prepend_file":
				ensureHashlineEditHasContent(edit);
				break;
		}
	}
	return mismatches;

	function validateHashlineRef(ref: { line: number; hash: string }): void {
		if (ref.line < 1 || ref.line > fileLines.length) {
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
		}
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash === ref.hash) {
			return;
		}
		const rebased = tryRebaseAnchor(ref, fileLines);
		if (rebased !== null) {
			const original = `${ref.line}${ref.hash}`;
			ref.line = rebased;
			warnings.push(
				`Auto-rebased anchor ${original} → ${rebased}${ref.hash} (line shifted within ±${ANCHOR_REBASE_WINDOW}; hash matched).`,
			);
			return;
		}
		mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
	}
}
// ═══════════════════════════════════════════════════════════════════════════
// Edit Application
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply an array of hashline edits to file content.
 *
 * Each edit operation identifies target lines directly (`replace`,
 * `append`, `prepend`). Line references are resolved via {@link parseTag}
 * and hashes validated before any mutation.
 *
 * Edits are sorted bottom-up (highest effective line first) so earlier
 * splices don't invalidate later line numbers.
 *
 * @returns The modified content and the 1-indexed first changed line number
 */
export function applyHashlineEdits(
	text: string,
	edits: HashlineEdit[],
): {
	lines: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
} {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const originalFileLines = [...fileLines];
	let firstChangedLine: number | undefined;
	const noopEdits: Array<{ editIndex: number; loc: string; current: string }> = [];
	const warnings: string[] = [];

	const mismatches = validateHashlineEditRefs(edits, fileLines, warnings);
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}
	for (const edit of edits) {
		collectBoundaryDuplicationWarning(edit, originalFileLines, warnings);
	}
	dedupeHashlineEdits(edits);

	const annotated = edits
		.map((edit, idx) => {
			const { sortLine, precedence } = getHashlineEditSortKey(edit, fileLines.length);
			return { edit, idx, sortLine, precedence };
		})
		.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);

	for (const { edit, idx } of annotated) {
		applyHashlineEditToLines(edit, fileLines, originalFileLines, idx, noopEdits, trackFirstChanged);
	}

	return buildHashlineEditResult({ fileLines, firstChangedLine, warnings, noopEdits });

	function trackFirstChanged(line: number): void {
		if (firstChangedLine === undefined || line < firstChangedLine) {
			firstChangedLine = line;
		}
	}
}

export interface CompactHashlineDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

export interface CompactHashlineDiffOptions {
	maxUnchangedRun?: number;
	maxDeletionRun?: number;
	maxOutputLines?: number;
}

const NUMBERED_DIFF_LINE_RE = /^([ +-])(\s*\d+)\|(.*)$/;
const HASHLINE_PREVIEW_PLACEHOLDER = "  ";

type DiffRunKind = " " | "+" | "-" | "meta";
type DiffRun = { kind: DiffRunKind; lines: string[] };

interface ParsedNumberedDiffLine {
	kind: " " | "+" | "-";
	lineNumber: number;
	lineWidth: number;
	content: string;
	raw: string;
}

interface CompactPreviewCounters {
	oldLine?: number;
	newLine?: number;
}

function parseNumberedDiffLine(line: string): ParsedNumberedDiffLine | undefined {
	const match = NUMBERED_DIFF_LINE_RE.exec(line);
	if (!match) return undefined;

	const kind = match[1];
	if (kind !== " " && kind !== "+" && kind !== "-") return undefined;

	const lineField = match[2];
	const lineNumber = Number(lineField.trim());
	if (!Number.isInteger(lineNumber)) return undefined;

	return { kind, lineNumber, lineWidth: lineField.length, content: match[3], raw: line };
}

function syncOldLineCounters(counters: CompactPreviewCounters, lineNumber: number): void {
	if (counters.oldLine === undefined || counters.newLine === undefined) {
		counters.oldLine = lineNumber;
		counters.newLine = lineNumber;
		return;
	}

	const delta = lineNumber - counters.oldLine;
	counters.oldLine = lineNumber;
	counters.newLine += delta;
}

function syncNewLineCounters(counters: CompactPreviewCounters, lineNumber: number): void {
	if (counters.oldLine === undefined || counters.newLine === undefined) {
		counters.oldLine = lineNumber;
		counters.newLine = lineNumber;
		return;
	}

	const delta = lineNumber - counters.newLine;
	counters.oldLine += delta;
	counters.newLine = lineNumber;
}

function formatCompactHashlineLine(kind: " " | "+", lineNumber: number, content: string): string {
	return `${kind}${lineNumber}${computeLineHash(lineNumber, content)}${HASHLINE_CONTENT_SEPARATOR}${content}`;
}

function formatCompactRemovedLine(lineNumber: number, content: string): string {
	return `-${lineNumber}${HASHLINE_PREVIEW_PLACEHOLDER}${HASHLINE_CONTENT_SEPARATOR}${content}`;
}

function formatCompactPreviewLine(line: string, counters: CompactPreviewCounters): { kind: DiffRunKind; text: string } {
	const parsed = parseNumberedDiffLine(line);
	if (!parsed) return { kind: "meta", text: line };

	if (parsed.content === "...") {
		if (parsed.kind === "+") {
			syncNewLineCounters(counters, parsed.lineNumber);
		} else {
			syncOldLineCounters(counters, parsed.lineNumber);
		}
		return { kind: parsed.kind, text: parsed.raw };
	}

	switch (parsed.kind) {
		case "+": {
			syncNewLineCounters(counters, parsed.lineNumber);
			const newLine = counters.newLine;
			if (newLine === undefined) return { kind: "+", text: parsed.raw };
			const text = formatCompactHashlineLine("+", newLine, parsed.content);
			counters.newLine = newLine + 1;
			return { kind: "+", text };
		}
		case "-": {
			syncOldLineCounters(counters, parsed.lineNumber);
			const text = formatCompactRemovedLine(parsed.lineNumber, parsed.content);
			counters.oldLine = parsed.lineNumber + 1;
			return { kind: "-", text };
		}
		case " ": {
			syncOldLineCounters(counters, parsed.lineNumber);
			const newLine = counters.newLine;
			if (newLine === undefined) return { kind: " ", text: parsed.raw };
			const text = formatCompactHashlineLine(" ", newLine, parsed.content);
			counters.oldLine = parsed.lineNumber + 1;
			counters.newLine = newLine + 1;
			return { kind: " ", text };
		}
	}
}

function splitDiffRuns(lines: string[]): DiffRun[] {
	const runs: DiffRun[] = [];
	const counters: CompactPreviewCounters = {};

	for (const line of lines) {
		const formatted = formatCompactPreviewLine(line, counters);
		const prev = runs[runs.length - 1];
		if (prev && prev.kind === formatted.kind) {
			prev.lines.push(formatted.text);
			continue;
		}
		runs.push({ kind: formatted.kind, lines: [formatted.text] });
	}

	return runs;
}

function collapseFromStart(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	return [...lines.slice(0, maxLines), ` ... ${hidden} more ${label} lines`];
}

function _collapseFromEnd(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	return [` ... ${hidden} more ${label} lines`, ...lines.slice(-maxLines)];
}

function collapseFromMiddle(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines * 2) return lines;
	const hidden = lines.length - maxLines * 2;
	return [...lines.slice(0, maxLines), ` ... ${hidden} more ${label} lines`, ...lines.slice(-maxLines)];
}

/**
 * Build a compact diff preview suitable for model-visible tool responses.
 *
 * Collapses long unchanged runs and long consecutive additions/removals so the
 * model sees the shape of edits without replaying full file content.
 */
export function buildCompactHashlineDiffPreview(
	diff: string,
	options: CompactHashlineDiffOptions = {},
): CompactHashlineDiffPreview {
	const maxUnchangedRun = options.maxUnchangedRun ?? 2;
	const maxDeletionRun = options.maxDeletionRun ?? 2;
	const maxOutputLines = options.maxOutputLines ?? 16;

	const inputLines = diff.length === 0 ? [] : diff.split("\n");
	const runs = splitDiffRuns(inputLines);

	const out: string[] = [];
	let addedLines = 0;
	let removedLines = 0;

	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex];
		switch (run.kind) {
			case "meta":
				out.push(...run.lines);
				break;
			case "+":
				addedLines += run.lines.length;
				out.push(...run.lines);
				break;
			case "-":
				removedLines += run.lines.length;
				out.push(...collapseFromStart(run.lines, maxDeletionRun, "removed"));
				break;
			case " ":
				if (runIndex === 0) {
					out.push(...run.lines.slice(-maxUnchangedRun));
					break;
				}
				if (runIndex === runs.length - 1) {
					out.push(...run.lines.slice(0, maxUnchangedRun));
					break;
				}
				out.push(...collapseFromMiddle(run.lines, maxUnchangedRun, "unchanged"));
				break;
		}
	}

	if (out.length > maxOutputLines) {
		const hidden = out.length - maxOutputLines;
		return {
			preview: [...out.slice(0, maxOutputLines), ` ... ${hidden} more preview lines`].join("\n"),
			addedLines,
			removedLines,
		};
	}

	return { preview: out.join("\n"), addedLines, removedLines };
}

export async function computeHashlineDiff(
	input: { path: string; edits: HashlineEditInput[] },
	cwd: string,
): Promise<
	| {
			diff: string;
			firstChangedLine: number | undefined;
	  }
	| {
			error: string;
	  }
> {
	const { path, edits } = input;

	try {
		const absolutePath = resolveToCwd(path, cwd);
		const resolvedEdits = resolveHashlineEditsForDiff(edits);
		const file = Bun.file(absolutePath);

		const rawContent = await readHashlineFileText(file, path);

		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const result = applyHashlineEdits(normalizedContent, resolvedEdits);
		if (normalizedContent === result.lines) {
			return { error: `No changes would be made to ${path}. The edits produce identical content.` };
		}

		return generateDiffString(normalizedContent, result.lines);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function readHashlineFileText(file: BunFile, path: string): Promise<string> {
	try {
		return await file.text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${path}`);
	}
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const { session, path, edits, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;

	const contentEdits = edits.filter(e => e.loc != null);

	enforcePlanModeWrite(session, path, { op: "update" });

	if (path.endsWith(".ipynb") && contentEdits.length > 0) {
		throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
	}

	const absolutePath = resolvePlanPath(session, path);

	const sourceFile = Bun.file(absolutePath);
	const sourceExists = await sourceFile.exists();

	if (!sourceExists) {
		const lines: string[] = [];
		for (const edit of contentEdits) {
			if (edit.loc === "append") {
				lines.push(...hashlineParseText(edit.content));
			} else if (edit.loc === "prepend") {
				lines.unshift(...hashlineParseText(edit.content));
			} else {
				throw new Error(`File not found: ${path}`);
			}
		}

		await Bun.write(absolutePath, lines.join("\n"));
		invalidateFsScanAfterWrite(absolutePath);
		return {
			content: [{ type: "text", text: `Created ${path}` }],
			details: {
				diff: "",
				op: "create",
				meta: outputMeta().get(),
			},
		};
	}

	const anchorEdits = resolveEditAnchors(contentEdits);
	const rawContent = await sourceFile.text();
	assertEditableFileContent(rawContent, path);

	const { bom, text } = stripBom(rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);
	let normalizedText = originalNormalized;

	const anchorResult = applyHashlineEdits(normalizedText, anchorEdits);
	normalizedText = anchorResult.lines;

	const result = {
		text: normalizedText,
		firstChangedLine: anchorResult.firstChangedLine,
		warnings: anchorResult.warnings,
		noopEdits: anchorResult.noopEdits,
	};
	if (originalNormalized === result.text) {
		let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
		if (result.noopEdits && result.noopEdits.length > 0) {
			const details = result.noopEdits
				.map(
					edit =>
						`Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}| ${edit.current}`,
				)
				.join("\n");
			diagnostic += `\n${details}`;
			if (result.noopEdits.length === 1 && result.noopEdits[0]?.current) {
				const preview = result.noopEdits[0].current.trimEnd();
				if (preview.length > 0) {
					diagnostic += `\nThe file currently contains these lines:\n${preview}\nYour edits were normalized back to the original content (whitespace-only differences are preserved as-is). Ensure your replacement changes actual code, not just formatting.`;
				}
			}
			if (result.noopEdits.some(e => e.loc.includes("-"))) {
				diagnostic +=
					"\nHint: a `range` loc replaces the entire span inclusive of both endpoints. " +
					"If your replacement repeats the existing content, narrow the range or change the replacement.";
			}
		}
		throw new Error(diagnostic);
	}

	const finalContent = bom + restoreLineEndings(result.text, originalEnding);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);

	const diffResult = generateDiffString(originalNormalized, result.text);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	const resultText = `Updated ${path}`;
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);
	const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${preview.preview ? "" : " (no textual diff preview)"}`;
	const warningsBlock = result.warnings?.length ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n\nDiff preview:\n${preview.preview}` : "";

	return {
		content: [
			{
				type: "text",
				text: `${resultText}\n${summaryLine}${previewBlock}${warningsBlock}`,
			},
		],
		details: {
			diff: diffResult.diff,
			firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
			diagnostics,
			op: "update",
			meta,
		},
	};
}
