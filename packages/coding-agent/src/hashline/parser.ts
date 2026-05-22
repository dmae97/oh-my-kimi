import { ABORT_MARKER, ABORT_WARNING, BEGIN_PATCH_MARKER, END_PATCH_MARKER, RANGE_INTERIOR_HASH } from "./constants";
import {
	describeAnchorExamples,
	HL_FILE_PREFIX,
	HL_HASH_CAPTURE_RE_RAW,
	HL_OP_CHARS,
	HL_OP_INSERT_AFTER,
	HL_OP_INSERT_BEFORE,
	HL_OP_REPLACE,
} from "./hash";
import type { Anchor, HashlineCursor, HashlineEdit } from "./types";

const LID_CAPTURE_RE = new RegExp(`^${HL_HASH_CAPTURE_RE_RAW}$`);
const regexEscape = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
	if (!raw.includes("..")) {
		const start = parseLid(raw, lineNum);
		return { start, end: { ...start } };
	}
	const [startRaw, endRaw, extra] = raw.split("..");
	if (extra !== undefined || !startRaw || !endRaw) {
		throw new Error(
			`line ${lineNum}: range must include exactly two full anchors separated by "..". ` +
				`For a one-line edit, repeat the same anchor on both sides.`,
		);
	}
	const start = parseLid(startRaw, lineNum);
	const end = parseLid(endRaw, lineNum);
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

const INSERT_BEFORE_OP_RE = new RegExp(`^${regexEscape(HL_OP_INSERT_BEFORE)}\\s*(\\S+)\\s*$`);
const INSERT_AFTER_OP_RE = new RegExp(`^${regexEscape(HL_OP_INSERT_AFTER)}\\s*(\\S+)\\s*$`);
const REPLACE_OP_RE = new RegExp(`^${regexEscape(HL_OP_REPLACE)}\\s*([^\\s+<\\-=]\\S*)\\s*$`);

function isEnvelopeOrAbortMarkerLine(line: string): boolean {
	const trimmed = line.trimEnd();
	return trimmed === BEGIN_PATCH_MARKER || trimmed === END_PATCH_MARKER || trimmed === ABORT_MARKER;
}

function isPayloadTerminatorLine(line: string): boolean {
	const first = line[0];
	return (
		first === HL_FILE_PREFIX ||
		(first !== undefined && HL_OP_CHARS.includes(first)) ||
		isEnvelopeOrAbortMarkerLine(line)
	);
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

		const replaceMatch = REPLACE_OP_RE.exec(line);
		if (replaceMatch) {
			const range = parseRange(replaceMatch[1], lineNum);
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, false);
			if (payload.length > 0) {
				for (const text of payload) {
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

		if (isPayloadTerminatorLine(line) || /^[-@\u00B6]/u.test(line)) {
			throw new Error(
				`line ${lineNum}: unrecognized op. Use ${HL_OP_INSERT_BEFORE}ANCHOR (insert before), ${HL_OP_INSERT_AFTER}ANCHOR (insert after), or ${HL_OP_REPLACE}A..B (replace/delete). ` +
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
