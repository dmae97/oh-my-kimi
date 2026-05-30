/**
 * Compatibility surface for the legacy Hashline exports that were originally
 * published from `@oh-my-pi/pi-natives`.
 *
 * The implementation delegates to the standalone `@oh-my-pi/hashline` core so
 * existing `pi-natives` consumers keep linking while new code can depend on the
 * dedicated package directly.
 */
import * as Diff from "diff";
import { applyEdits } from "./apply";
import { buildCompactDiffPreview } from "./diff-preview";
import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLine,
	formatNumberedLines,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
} from "./format";
import grammar from "./grammar.lark" with { type: "text" };
import { containsRecognizableHashlineOperations, Patch } from "./input";
import { parsePatch } from "./parser";
import { hashlineParseText, stripHashlinePrefixes, stripNewLinePrefixes } from "./prefixes";
import { Recovery } from "./recovery";
import { type Snapshot, SnapshotStore } from "./snapshots";
import { streamHashLines } from "./stream";
import { Tokenizer } from "./tokenizer";
import type { Anchor, CompactDiffPreview, Cursor, Edit, ParsedRange, SplitOptions, StreamOptions } from "./types";

export const HashlineCursorKind = {
	Bof: "bof",
	Eof: "eof",
	BeforeAnchor: "before_anchor",
	AfterAnchor: "after_anchor",
} as const;

export type HashlineCursorKind = (typeof HashlineCursorKind)[keyof typeof HashlineCursorKind];

export const HashlineEditKind = {
	Insert: "insert",
	Delete: "delete",
} as const;

export type HashlineEditKind = (typeof HashlineEditKind)[keyof typeof HashlineEditKind];

export const HashlineTokenKind = {
	Blank: "blank",
	EnvelopeBegin: "envelope-begin",
	EnvelopeEnd: "envelope-end",
	Abort: "abort",
	Header: "header",
	OpBlock: "op-block",
	OpInsert: "op-block",
	OpReplace: "op-block",
	OpDelete: "op-block",
	Payload: "payload-literal",
	PayloadLiteral: "payload-literal",
	Raw: "raw",
} as const;

export type HashlineTokenKind = (typeof HashlineTokenKind)[keyof typeof HashlineTokenKind];

export type { Anchor };

export type CompactHashlineDiffPreview = CompactDiffPreview;

export interface DiffResult {
	diff: string;
	firstChangedLine?: number;
}

export interface FileReadSnapshot {
	lines: Array<SnapshotLine>;
	fullText?: string;
	fileHash?: string;
}

export type HashlineApplyOptions = {
	autoDropPureInsertDuplicates?: boolean;
};

export interface HashlineApplyResult {
	lines: string;
	firstChangedLine?: number;
	warnings?: Array<string>;
	noopEdits?: Array<HashlineNoopEdit>;
}

export type HashlineCursor =
	| { kind: typeof HashlineCursorKind.Bof }
	| { kind: typeof HashlineCursorKind.Eof }
	| { kind: typeof HashlineCursorKind.BeforeAnchor; anchor: Anchor }
	| { kind: typeof HashlineCursorKind.AfterAnchor; anchor: Anchor };

export interface HashlineEdit {
	kind: HashlineEditKind;
	lineNum: number;
	index: number;
	cursor?: HashlineCursor;
	text?: string;
	anchor?: Anchor;
	oldAssertion?: string;
	mode?: "replacement";
}

export interface HashlineInputSection {
	path: string;
	fileHash?: string;
	diff: string;
}

export interface HashlineNoopEdit {
	editIndex: number;
	loc: string;
	reason: string;
	current: string;
}

export type HashlineRange = ParsedRange;

export interface HashlineRecoveryArgs {
	path: string;
	currentText: string;
	fileHash: string;
	edits: Array<HashlineEdit>;
	headSnapshot?: FileReadSnapshot;
	targetSnapshot?: FileReadSnapshot;
	options?: HashlineApplyOptions;
}

export interface HashlineRecoveryResult {
	lines: string;
	firstChangedLine?: number;
	warnings: Array<string>;
}

export type HashlineStreamOptions = StreamOptions;

export interface HashlineToken {
	kind: HashlineTokenKind;
	lineNum: number;
	path?: string;
	fileHash?: string;
	cursor?: HashlineCursor;
	range?: HashlineRange;
	inlineBody?: string;
	trailingPayload?: boolean;
	text?: string;
}

export interface ParseResult {
	edits: Array<HashlineEdit>;
	warnings: Array<string>;
}

export interface SnapshotLine {
	line: number;
	text: string;
}

export type SplitHashlineOptions = SplitOptions;

interface NumberedDiffPart {
	added?: boolean;
	removed?: boolean;
	value: string;
}

function assertFileHash(
	filePath: string,
	expectedHash: string | undefined,
	text: string,
	edits: readonly Edit[],
): void {
	if (expectedHash === undefined) {
		if (
			edits.some(
				edit =>
					edit.kind === "delete" || edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor",
			)
		) {
			throw new Error(
				`Missing hashline file hash for anchored edit to ${filePath}; use \`${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}hash\` from your latest read.`,
			);
		}
		return;
	}

	const currentHash = computeFileHash(text);
	if (currentHash !== expectedHash.toUpperCase()) {
		throw new Error(
			`Hashline file hash mismatch for ${filePath}: section is bound to #${expectedHash}, but current file hashes to #${currentHash}; re-read and try again.`,
		);
	}
}

function assertFileHashTag(fileHash: string): void {
	if (/^[0-9A-Fa-f]{4}$/.test(fileHash)) return;
	throw new Error(`fileHash must be exactly four hex digits; got ${JSON.stringify(fileHash)}.`);
}

function toCompatApplyResult(result: {
	text: string;
	firstChangedLine?: number;
	warnings?: string[];
}): HashlineApplyResult {
	return {
		lines: result.text,
		firstChangedLine: result.firstChangedLine,
		...(result.warnings ? { warnings: result.warnings } : {}),
	};
}

function requireCursor(edit: HashlineEdit): Cursor {
	const cursor = edit.cursor;
	if (cursor === undefined) throw new Error(`Hashline insert edit ${edit.index} is missing a cursor.`);
	return cursor;
}

function requireText(edit: HashlineEdit): string {
	const text = edit.text;
	if (text === undefined) throw new Error(`Hashline insert edit ${edit.index} is missing text.`);
	return text;
}

function requireAnchor(edit: HashlineEdit): Anchor {
	const anchor = edit.anchor;
	if (anchor === undefined) throw new Error(`Hashline delete edit ${edit.index} is missing an anchor.`);
	return anchor;
}

function toCoreEdit(edit: HashlineEdit): Edit {
	if (edit.kind === HashlineEditKind.Insert) {
		return {
			kind: "insert",
			cursor: requireCursor(edit),
			text: requireText(edit),
			lineNum: edit.lineNum,
			index: edit.index,
			...(edit.mode === undefined ? {} : { mode: edit.mode }),
		};
	}
	if (edit.kind === HashlineEditKind.Delete) {
		return {
			kind: "delete",
			anchor: requireAnchor(edit),
			lineNum: edit.lineNum,
			index: edit.index,
			...(edit.oldAssertion !== undefined ? { oldAssertion: edit.oldAssertion } : {}),
		};
	}
	throw new Error(`Unsupported hashline edit kind: ${JSON.stringify(edit.kind)}.`);
}

function toCoreEdits(edits: readonly HashlineEdit[]): Edit[] {
	return edits.map(toCoreEdit);
}

function toPlainSection(section: { path: string; fileHash?: string; diff: string }): HashlineInputSection {
	return section.fileHash === undefined
		? { path: section.path, diff: section.diff }
		: { path: section.path, fileHash: section.fileHash, diff: section.diff };
}

function formatNumberedDiffLine(prefix: "+" | "-" | " ", lineNum: number, content: string): string {
	return `${prefix}${lineNum}|${content}`;
}

function generateNumberedDiff(oldContent: string, newContent: string, contextLines = 4): DiffResult {
	const parts = Diff.diffLines(oldContent, newContent) as NumberedDiffPart[];
	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			firstChangedLine ??= newLineNum;
			for (const line of raw) {
				if (part.added) {
					output.push(formatNumberedDiffLine("+", newLineNum, line));
					newLineNum++;
				} else {
					output.push(formatNumberedDiffLine("-", oldLineNum, line));
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[i + 1];
		const nextPartIsChange = Boolean(nextPart?.added || nextPart?.removed);
		if (lastWasChange || nextPartIsChange) {
			const contextLimit = Math.max(0, contextLines);
			let leadingSkip = 0;
			let middleSkip = 0;
			let trailingSkip = 0;
			let linesToShow: string[];

			if (lastWasChange && nextPartIsChange) {
				if (raw.length > contextLimit * 2) {
					const leadingContext = raw.slice(0, contextLimit);
					const trailingContext = raw.slice(raw.length - contextLimit);
					middleSkip = raw.length - leadingContext.length - trailingContext.length;
					linesToShow = leadingContext.concat(trailingContext);
				} else {
					linesToShow = raw;
				}
			} else if (nextPartIsChange) {
				leadingSkip = Math.max(0, raw.length - contextLimit);
				linesToShow = raw.slice(leadingSkip);
			} else {
				trailingSkip = Math.max(0, raw.length - contextLimit);
				linesToShow = raw.slice(0, contextLimit);
			}

			if (leadingSkip > 0) {
				output.push(formatNumberedDiffLine(" ", oldLineNum, "..."));
				oldLineNum += leadingSkip;
				newLineNum += leadingSkip;
			}

			const firstChunkLength = middleSkip > 0 ? contextLimit : linesToShow.length;
			for (const line of linesToShow.slice(0, firstChunkLength)) {
				output.push(formatNumberedDiffLine(" ", oldLineNum, line));
				oldLineNum++;
				newLineNum++;
			}

			if (middleSkip > 0) {
				output.push(formatNumberedDiffLine(" ", oldLineNum, "..."));
				oldLineNum += middleSkip;
				newLineNum += middleSkip;
				for (const line of linesToShow.slice(firstChunkLength)) {
					output.push(formatNumberedDiffLine(" ", oldLineNum, line));
					oldLineNum++;
					newLineNum++;
				}
			}

			if (trailingSkip > 0) {
				output.push(formatNumberedDiffLine(" ", oldLineNum, "..."));
				oldLineNum += trailingSkip;
				newLineNum += trailingSkip;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

function buildSparseOverlayText(currentText: string, lines: readonly SnapshotLine[]): string {
	const overlaid = currentText.split("\n");
	let maxCachedLine = 0;
	for (const line of lines) {
		if (line.line > maxCachedLine) maxCachedLine = line.line;
	}
	while (overlaid.length < maxCachedLine) overlaid.push("");
	for (const line of lines) overlaid[line.line - 1] = line.text;
	return overlaid.join("\n");
}

function toSnapshot(
	input: FileReadSnapshot | undefined,
	path: string,
	currentText: string,
	fallbackHash?: string,
): Snapshot | null {
	if (input === undefined) return null;
	const text = input.fullText ?? buildSparseOverlayText(currentText, input.lines);
	const hash = input.fileHash ?? fallbackHash ?? computeFileHash(text);
	return { path, text, hash: hash.toUpperCase(), recordedAt: Date.now() };
}

class SingleRecoverySnapshotStore extends SnapshotStore {
	readonly #headSnapshot: Snapshot | null;
	readonly #targetSnapshot: Snapshot | null;

	constructor(args: HashlineRecoveryArgs) {
		super();
		this.#targetSnapshot = toSnapshot(args.targetSnapshot, args.path, args.currentText, args.fileHash);
		this.#headSnapshot = toSnapshot(args.headSnapshot, args.path, args.currentText) ?? this.#targetSnapshot;
	}

	head(_path: string): Snapshot | null {
		return this.#headSnapshot;
	}

	byHash(_path: string, fileHash: string): Snapshot | null {
		return this.#targetSnapshot?.hash === fileHash.toUpperCase() ? this.#targetSnapshot : null;
	}

	record(_path: string, fullText: string): string {
		return computeFileHash(fullText);
	}

	invalidate(): void {}

	clear(): void {}
}

/** Stateful chunker that formats a UTF-8 text stream into numbered hashline chunks. */
export class HashlineChunker {
	#lineNumber: number;
	#maxChunkLines: number;
	#maxChunkBytes: number;
	#outLines: string[] = [];
	#outBytes = 0;
	#pending = "";
	#sawAnyLine = false;
	#closed = false;

	constructor(options: HashlineStreamOptions = {}) {
		this.#lineNumber = options.startLine ?? 1;
		this.#maxChunkLines = options.maxChunkLines ?? 200;
		this.#maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
	}

	push(chunk: string): Array<string> {
		if (this.#closed) throw new Error("HashlineChunker is closed; create a new chunker for another stream.");
		if (chunk.length === 0) return [];

		const chunks: string[] = [];
		this.#pending += chunk;
		let nl = this.#pending.indexOf("\n");
		while (nl !== -1) {
			const raw = this.#pending.slice(0, nl);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			this.#sawAnyLine = true;
			chunks.push(...this.#pushLine(line));
			this.#pending = this.#pending.slice(nl + 1);
			nl = this.#pending.indexOf("\n");
		}
		return chunks;
	}

	finish(): Array<string> {
		if (this.#closed) return [];
		this.#closed = true;
		const chunks: string[] = [];
		if (this.#pending.length > 0) {
			const tail = this.#pending.endsWith("\r") ? this.#pending.slice(0, -1) : this.#pending;
			this.#sawAnyLine = true;
			chunks.push(...this.#pushLine(tail));
		}
		if (!this.#sawAnyLine) chunks.push(...this.#pushLine(""));
		const last = this.#flush();
		if (last) chunks.push(last);
		return chunks;
	}

	#pushLine(line: string): Array<string> {
		const formatted = formatNumberedLine(this.#lineNumber, line);
		this.#lineNumber++;

		const chunks: string[] = [];
		const sepBytes = this.#outLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(formatted, "utf-8");
		const wouldOverflow =
			this.#outLines.length >= this.#maxChunkLines || this.#outBytes + sepBytes + lineBytes > this.#maxChunkBytes;

		if (this.#outLines.length > 0 && wouldOverflow) {
			const flushed = this.#flush();
			if (flushed) chunks.push(flushed);
		}

		this.#outLines.push(formatted);
		this.#outBytes += (this.#outLines.length === 1 ? 0 : 1) + lineBytes;

		if (this.#outLines.length >= this.#maxChunkLines || this.#outBytes >= this.#maxChunkBytes) {
			const flushed = this.#flush();
			if (flushed) chunks.push(flushed);
		}
		return chunks;
	}

	#flush(): string | undefined {
		if (this.#outLines.length === 0) return undefined;
		const chunk = this.#outLines.join("\n");
		this.#outLines = [];
		this.#outBytes = 0;
		return chunk;
	}
}

// biome-ignore lint/complexity/noStaticOnlyClass: Legacy pi-natives API is a static-only class.
export class Hashline {
	static grammar(): string {
		return grammar;
	}

	static computeFileHash(text: string): string {
		return computeFileHash(text);
	}

	static formatHeader(path: string, fileHash: string): string {
		assertFileHashTag(fileHash);
		return formatHashlineHeader(path, fileHash);
	}

	static formatLine(lineNumber: number, line: string): string {
		return formatNumberedLine(lineNumber, line);
	}

	static formatLines(text: string, startLine?: number | null): string {
		return formatNumberedLines(text, startLine ?? 1);
	}

	static tokenize(input: string): Array<HashlineToken> {
		return new Tokenizer().tokenizeAll(input) as Array<HashlineToken>;
	}

	static parse(input: string): ParseResult {
		return parsePatch(input) as ParseResult;
	}

	static apply(text: string, edits: Array<HashlineEdit>, _options: HashlineApplyOptions = {}): HashlineApplyResult {
		return toCompatApplyResult(applyEdits(text, toCoreEdits(edits)));
	}

	static parseAndApply(input: string, text: string, options: HashlineApplyOptions = {}): HashlineApplyResult {
		const parsed = Hashline.parse(input);
		return Hashline.apply(text, parsed.edits, options);
	}

	static split(input: string, options: SplitHashlineOptions = {}): Array<HashlineInputSection> {
		return Patch.parse(input, options).sections.map(toPlainSection);
	}

	static splitOne(input: string, options: SplitHashlineOptions = {}): HashlineInputSection {
		const sections = Hashline.split(input, options);
		if (sections.length !== 1)
			throw new Error(`Patch input produced ${sections.length} sections; expected exactly one.`);
		return sections[0];
	}

	static containsOps(input: string): boolean {
		return containsRecognizableHashlineOperations(input);
	}

	static computeSectionDiff(
		section: HashlineInputSection,
		text: string,
		_options: HashlineApplyOptions = {},
	): DiffResult {
		const parsed = Patch.parse(
			`${HL_FILE_PREFIX}${section.path}${section.fileHash ? `${HL_FILE_HASH_SEP}${section.fileHash}` : ""}\n${section.diff}`,
		).sections[0];
		if (!parsed) throw new Error("Patch input did not produce any sections.");
		const { edits } = parsed.parse();
		assertFileHash(section.path, section.fileHash, text, edits);
		const result = applyEdits(text, [...edits]);
		return generateNumberedDiff(text, result.text);
	}

	static computeDiff(
		input: string,
		fallbackPath: string | undefined | null,
		text: string,
		options: HashlineApplyOptions = {},
	): DiffResult {
		return Hashline.computeSectionDiff(Hashline.splitOne(input, { path: fallbackPath ?? undefined }), text, options);
	}

	static compactPreview(diff: string): CompactHashlineDiffPreview {
		return buildCompactDiffPreview(diff);
	}

	static stripPrefixes(lines: Array<string>): Array<string> {
		return stripNewLinePrefixes(lines);
	}

	static stripHashlinePrefixes(lines: Array<string>): Array<string> {
		return stripHashlinePrefixes(lines);
	}

	static parseText(text?: string | Array<string> | null): Array<string> {
		return hashlineParseText(text);
	}

	static recover(args: HashlineRecoveryArgs): HashlineRecoveryResult | null {
		const store = new SingleRecoverySnapshotStore(args);
		const recovery = new Recovery(store);
		const recovered = recovery.tryRecover({
			path: args.path,
			currentText: args.currentText,
			fileHash: args.fileHash,
			edits: toCoreEdits(args.edits),
		});
		return recovered === null
			? null
			: {
					lines: recovered.text,
					firstChangedLine: recovered.firstChangedLine,
					warnings: recovered.warnings,
				};
	}

	static streamChunks(chunks: Array<string>, options: HashlineStreamOptions = {}): Array<string> {
		const chunker = new HashlineChunker(options);
		const out: string[] = [];
		for (const chunk of chunks) out.push(...chunker.push(chunk));
		out.push(...chunker.finish());
		return out;
	}
}

export { streamHashLines };
