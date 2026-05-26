import { ABORT_MARKER, ABORT_WARNING, BEGIN_PATCH_MARKER, END_PATCH_MARKER, RANGE_INTERIOR_HASH } from "./constants";
import {
	describeAnchorExamples,
	HL_FILE_PREFIX,
	HL_HASH_CAPTURE_RE_RAW,
	HL_HASH_RE_RAW,
	HL_OP_CHARS,
	HL_OP_INSERT_AFTER,
	HL_OP_INSERT_BEFORE,
	HL_OP_REPLACE,
} from "./hash";
import type { Anchor, HashlineCursor, HashlineEdit } from "./types";

const regexEscape = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OP_CHARS_ESCAPED = regexEscape(HL_OP_CHARS);

// Leniently accept anchors copied from read/search output:
//   - optional leading line-marker decoration (`*`, `>`, `+`, `-`)
//   - the required `LINE+HASH`
//   - an optional trailing `|TEXT` body so users can paste a full
//     `LINE+HASH|TEXT` line verbatim.
const LID_CAPTURE_RE = new RegExp(`^\\s*[>+\\-*]*\\s*${HL_HASH_CAPTURE_RE_RAW}(?:\\|.*)?\\s*$`);

// Pre-op anchor part for insert ops: leading decoration, then a LID or
// BOF/EOF, then optional `|TEXT` paste decoration. The decoration MUST NOT
// contain any op sigil so the op-line regex below knows where the anchor part
// ends. Trailing `\s*` allows space between the anchor and the op sigil.
const INSERT_ANCHOR_PART_RE_RAW = `\\s*[>+\\-*]*\\s*(?:${HL_HASH_RE_RAW}|BOF|EOF)(?:\\|[^${OP_CHARS_ESCAPED}\\n]*)?\\s*`;

// Pre-op range part for the replace op: optional decoration + LID, then an
// optional `-LID` end, then optional trailing `|TEXT` paste decoration. The
// `-` is the range separator; `|TEXT` between bounds is unsupported (TEXT may
// contain `-`), trailing decoration after the full range is still tolerated.
const RANGE_PART_RE_RAW = `\\s*[>+\\-*]*\\s*${HL_HASH_RE_RAW}(?:-${HL_HASH_RE_RAW})?(?:\\|[^${OP_CHARS_ESCAPED}\\n]*)?\\s*`;

// Op lines place the operator AFTER the anchor/range. Group 1 captures the
// anchor (or range) part; group 2 captures the optional inline payload that
// follows the op sigil on the same line, with trailing whitespace eaten.
const INSERT_BEFORE_OP_RE = new RegExp(`^(${INSERT_ANCHOR_PART_RE_RAW})${regexEscape(HL_OP_INSERT_BEFORE)}(.*?)\\s*$`);
const INSERT_AFTER_OP_RE = new RegExp(`^(${INSERT_ANCHOR_PART_RE_RAW})${regexEscape(HL_OP_INSERT_AFTER)}(.*?)\\s*$`);
const REPLACE_OP_RE = new RegExp(`^(${RANGE_PART_RE_RAW})${regexEscape(HL_OP_REPLACE)}(.*?)\\s*$`);

// Range parser: a bare `LINE+HASH` or `LINE+HASH-LINE+HASH` with optional
// leading decoration and optional trailing `|TEXT` paste decoration. Captures
// 1/2 = start line/hash, 3/4 = optional end line/hash.
const RANGE_PARSE_RE = new RegExp(
	`^\\s*[>+\\-*]*\\s*${HL_HASH_CAPTURE_RE_RAW}(?:-${HL_HASH_CAPTURE_RE_RAW})?(?:\\|.*)?\\s*$`,
);

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
	const match = RANGE_PARSE_RE.exec(raw);
	if (!match) {
		throw new Error(
			`line ${lineNum}: range must be ANCHOR or ANCHOR-ANCHOR (one dash, no spaces); ` +
				`got ${JSON.stringify(raw)}.`,
		);
	}
	const start: Anchor = { line: Number.parseInt(match[1], 10), hash: match[2] };
	const end: Anchor = match[3] !== undefined ? { line: Number.parseInt(match[3], 10), hash: match[4] } : { ...start };
	if (end.line < start.line) {
		throw new Error(
			`line ${lineNum}: range ${start.line}${start.hash}-${end.line}${end.hash} ends before it starts.`,
		);
	}
	if (end.line === start.line && end.hash !== start.hash) {
		throw new Error(
			`line ${lineNum}: range ${start.line}${start.hash}-${end.line}${end.hash} uses two different hashes for the same line.`,
		);
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

// `BOF`/`EOF` with optional leading decoration and optional `|TEXT` trailing
// paste decoration. The token is recognized verbatim; any `|TEXT` is discarded.
const BOF_RE = /^\s*[>+\-*]*\s*BOF(?:\|[^\n]*)?\s*$/;
const EOF_RE = /^\s*[>+\-*]*\s*EOF(?:\|[^\n]*)?\s*$/;

function parseInsertTarget(raw: string, lineNum: number, kind: "before" | "after"): HashlineCursor {
	if (BOF_RE.test(raw)) return { kind: "bof" };
	if (EOF_RE.test(raw)) return { kind: "eof" };
	const cursorKind = kind === "before" ? "before_anchor" : "after_anchor";
	return { kind: cursorKind, anchor: parseLid(raw, lineNum) };
}

function isEnvelopeOrAbortMarkerLine(line: string): boolean {
	const trimmed = line.trimEnd();
	return trimmed === BEGIN_PATCH_MARKER || trimmed === END_PATCH_MARKER || trimmed === ABORT_MARKER;
}

export function isHashlineOpLineText(line: string): boolean {
	return INSERT_BEFORE_OP_RE.test(line) || INSERT_AFTER_OP_RE.test(line) || REPLACE_OP_RE.test(line);
}

function isPayloadTerminatorLine(line: string): boolean {
	if (line.startsWith(HL_FILE_PREFIX)) return true;
	if (isHashlineOpLineText(line)) return true;
	return isEnvelopeOrAbortMarkerLine(line);
}

export function cloneCursor(cursor: HashlineCursor): HashlineCursor {
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
		const line = lines[index];
		if (isPayloadTerminatorLine(line)) break;
		payload.push(line);
		index++;
	}
	if (payload.length === 0 && requirePayload) {
		throw new Error(
			`line ${opLineNum}: ${HL_OP_INSERT_BEFORE} and ${HL_OP_INSERT_AFTER} operations require at least one verbatim payload line.`,
		);
	}
	return { payload, nextIndex: index };
}

export function parseHashline(diff: string): HashlineEdit[] {
	return parseHashlineWithWarnings(diff).edits;
}

export function parseHashlineWithWarnings(diff: string): { edits: HashlineEdit[]; warnings: string[] } {
	const edits: HashlineEdit[] = [];
	const warnings: string[] = [];
	const lines = diff.split(/\r?\n/);
	if (diff.endsWith("\n") && lines.at(-1) === "") lines.pop();
	let editIndex = 0;

	const pushInsert = (cursor: HashlineCursor, text: string, lineNum: number) => {
		edits.push({ kind: "insert", cursor: cloneCursor(cursor), text, lineNum, index: editIndex++ });
	};

	for (let i = 0; i < lines.length; ) {
		const lineNum = i + 1;
		const line = lines[i];

		if (line.trim().length === 0) {
			i++;
			continue;
		}
		if (line === END_PATCH_MARKER) {
			break;
		}
		if (line === ABORT_MARKER) {
			warnings.push(ABORT_WARNING);
			break;
		}
		if (line === BEGIN_PATCH_MARKER) {
			i++;
			continue;
		}

		const insertBeforeMatch = INSERT_BEFORE_OP_RE.exec(line);
		if (insertBeforeMatch) {
			const cursor = parseInsertTarget(insertBeforeMatch[1], lineNum, "before");
			const inlineBody = insertBeforeMatch[2].length > 0 ? insertBeforeMatch[2] : undefined;
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, inlineBody === undefined);
			if (inlineBody !== undefined) pushInsert(cursor, inlineBody, lineNum);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const insertAfterMatch = INSERT_AFTER_OP_RE.exec(line);
		if (insertAfterMatch) {
			const cursor = parseInsertTarget(insertAfterMatch[1], lineNum, "after");
			const inlineBody = insertAfterMatch[2].length > 0 ? insertAfterMatch[2] : undefined;
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, inlineBody === undefined);
			if (inlineBody !== undefined) pushInsert(cursor, inlineBody, lineNum);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const replaceMatch = REPLACE_OP_RE.exec(line);
		if (replaceMatch) {
			const range = parseRange(replaceMatch[1], lineNum);
			const inlineBody = replaceMatch[2].length > 0 ? replaceMatch[2] : undefined;
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, false);
			const allPayload = inlineBody !== undefined ? [inlineBody, ...payload] : payload;
			if (allPayload.length > 0) {
				for (const text of allPayload) {
					edits.push({
						kind: "insert",
						cursor: { kind: "before_anchor", anchor: { ...range.start } },
						text,
						lineNum,
						index: editIndex++,
					});
				}
			}
			for (const anchor of expandRange(range)) {
				edits.push({ kind: "delete", anchor, lineNum, index: editIndex++ });
			}
			i = nextIndex;
			continue;
		}

		const firstChar = line[0];
		const startsWithOp = firstChar !== undefined && HL_OP_CHARS.includes(firstChar);
		if (startsWithOp || /^[-@«»\u2254\u00A7]/u.test(line)) {
			throw new Error(
				`line ${lineNum}: unrecognized op. Use ANCHOR${HL_OP_INSERT_BEFORE} (insert before), ANCHOR${HL_OP_INSERT_AFTER} (insert after), or A-B${HL_OP_REPLACE} (replace/delete). ` +
					`Got ${JSON.stringify(line)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding ${HL_OP_INSERT_BEFORE}, ${HL_OP_INSERT_AFTER}, or ${HL_OP_REPLACE} operation. ` +
				`Got ${JSON.stringify(line)}.`,
		);
	}

	return { edits, warnings };
}
