// Strict source-bound hashline proposal parser. No runtime imports and no ambient
// authority; Node/Bun compatible via globalThis.crypto.subtle. Public types live in
// ./proposal-types.ts and are re-exported below as an erased type-only export.
// allow: SIZE_OK — single-pass source-bound parser state machine: the discriminated
// edit union needs one exhaustive per-kind reducer arm (record construction, empty-body,
// block-anchor, span, and limit checks per op) plus typed deep-freeze walkers; collapsing
// arms back into positional tuples or assertion casts is the only way under 250 pure LOC.

import type {
	HashAnchor,
	HashProposal,
	HashProposalEdit,
	HashProposalError,
	HashProposalErrorCode,
	HashProposalParseResult,
	HashProposalSection,
} from "./proposal-types.js";

export type * from "./proposal-types.js";

export class HashProposalEncodingError extends Error {}

const SHA256_HEX_LEN = 64;
const MAX_PATCH_BYTES = 1 << 20;
const MAX_SECTIONS = 256;
const MAX_HUNKS = 10_000;
const MAX_EDITS = 100_000;
const MAX_SPAN = 100_000;
const MAX_NAME_LEN = 4096;
const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const SOURCE_DOMAIN = "hashline:proposal:source:v1\0";
const LINE_DOMAIN = "hashline:proposal:line:v1\0";
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const HEX_PART = `[0-9a-f]{${SHA256_HEX_LEN}}`;
const ANCHOR_PART = `([1-9]\\d*)@sha256:(${HEX_PART})`;
const HEADER_RE = new RegExp(`^\\[([^#\\r\\n]*)#sha256:(${HEX_PART})\\]$`);
const RANGE_RE = new RegExp(`^${ANCHOR_PART}\\.=${ANCHOR_PART}$`);
const ANCHOR_RE = new RegExp(`^${ANCHOR_PART}$`);
const HUNK_RE = /^(SWAP\.BLK|SWAP|DEL\.BLK|DEL|INS\.BLK\.POST|INS\.POST|INS\.PRE|INS\.HEAD|INS\.TAIL|REM|MV)\s*(.*)$/;

type RangedDraft = {
	kind: "replace" | "delete";
	sourceLine: number;
	start: HashAnchor;
	end: HashAnchor;
	body: string[];
};
type AnchoredDraft = {
	kind: "insert-before" | "insert-after" | "insert-after-block" | "replace-block" | "delete-block";
	sourceLine: number;
	anchor: HashAnchor;
	body: string[];
};
type FloatingDraft = { kind: "insert-head" | "insert-tail"; sourceLine: number; body: string[] };
type RemoveDraft = { kind: "remove"; sourceLine: number };
type MoveDraft = { kind: "move"; sourceLine: number; to: string };
type Draft = RangedDraft | AnchoredDraft | FloatingDraft | RemoveDraft | MoveDraft;
type LineExpectationDraft = { path: string; line: number; digest: string };
type FinalizedSection = { edits: HashProposalEdit[]; editUnits: number; spanUnits: number };
type ParsedSection = {
	section: HashProposalSection;
	nextIndex: number;
	nextLineNum: number;
	editUnits: number;
	spanUnits: number;
};

function hasLoneSurrogate(text: string): boolean {
	return LONE_SURROGATE_RE.test(text);
}
function utf8Bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}
async function domainDigest(domain: string, bytes: Uint8Array): Promise<string> {
	const domainBytes = utf8Bytes(domain);
	const combined = new Uint8Array(domainBytes.length + bytes.length);
	combined.set(domainBytes);
	combined.set(bytes, domainBytes.length);
	const hashed = await globalThis.crypto.subtle.digest("SHA-256", combined);
	return Array.from(new Uint8Array(hashed), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashProposalSource(text: string): Promise<string> {
	if (hasLoneSurrogate(text)) throw new HashProposalEncodingError("ill-formed UTF-16");
	const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
	return domainDigest(SOURCE_DOMAIN, utf8Bytes(withoutBom.replace(/\r\n?/g, "\n")));
}
export async function hashProposalLine(text: string): Promise<string> {
	if (hasLoneSurrogate(text)) throw new HashProposalEncodingError("ill-formed UTF-16");
	if (text.includes("\r") || text.includes("\n")) throw new HashProposalEncodingError("line contains newline");
	return domainDigest(LINE_DOMAIN, utf8Bytes(text));
}

function freezeEdit(edit: HashProposalEdit): void {
	if ("body" in edit) Object.freeze(edit.body);
	if ("start" in edit) {
		Object.freeze(edit.start);
		Object.freeze(edit.end);
	}
	if ("anchor" in edit) Object.freeze(edit.anchor);
	Object.freeze(edit);
}
function freezeProposal(value: HashProposal): HashProposal {
	for (const section of value.sections) {
		for (const edit of section.edits) freezeEdit(edit);
		Object.freeze(section.edits);
		Object.freeze(section);
	}
	for (const expectation of value.expectedFileHashes) Object.freeze(expectation);
	for (const expectation of value.expectedLineHashes) Object.freeze(expectation);
	Object.freeze(value.sections);
	Object.freeze(value.expectedFileHashes);
	Object.freeze(value.expectedLineHashes);
	return Object.freeze(value);
}
function makeError(code: HashProposalErrorCode, line: number | undefined, message: string): HashProposalError {
	return Object.freeze({ code, line, message });
}
function failure(code: HashProposalErrorCode, line: number | undefined, message: string): HashProposalParseResult {
	const result: HashProposalParseResult = { ok: false, error: makeError(code, line, message) };
	return Object.freeze(result);
}
function success(value: HashProposal): HashProposalParseResult {
	const result: HashProposalParseResult = { ok: true, value: freezeProposal(value) };
	return Object.freeze(result);
}

function parseLineNumber(raw: string, line: number): number | HashProposalError {
	const value = Number.parseInt(raw, 10);
	return Number.isNaN(value) || value.toString() !== raw || value > Number.MAX_SAFE_INTEGER || value <= 0
		? makeError("limit", line, "unsafe line number")
		: value;
}
function parseAnchor(raw: string, line: number): HashAnchor | HashProposalError {
	const match = ANCHOR_RE.exec(raw);
	if (match === null) return makeError("syntax", line, "bad anchor");
	const parsed = parseLineNumber(match[1], line);
	return typeof parsed === "number" ? { line: parsed, digest: match[2] } : parsed;
}
function parseRange(raw: string, line: number): { start: HashAnchor; end: HashAnchor } | HashProposalError {
	const match = RANGE_RE.exec(raw);
	if (match === null) return makeError("syntax", line, "bad range");
	const startLine = parseLineNumber(match[1], line);
	if (typeof startLine !== "number") return startLine;
	const endLine = parseLineNumber(match[3], line);
	if (typeof endLine !== "number") return endLine;
	if (startLine > endLine) return makeError("syntax", line, "range reversed");
	return { start: { line: startLine, digest: match[2] }, end: { line: endLine, digest: match[4] } };
}

function parseHunk(line: string, lineNum: number): Draft | HashProposalError {
	const match = HUNK_RE.exec(line);
	if (match === null) return makeError("syntax", lineNum, "bad hunk");
	const keyword = match[1];
	const rest = keyword === "MV" ? match[2].trim() : match[2].trim().replace(/:$/, "");
	if (keyword === "SWAP" || keyword === "DEL") {
		const range = parseRange(rest, lineNum);
		if ("code" in range) return range;
		const kind = keyword === "SWAP" ? "replace" : "delete";
		return { kind, sourceLine: lineNum, start: range.start, end: range.end, body: [] };
	}
	if (keyword === "INS.HEAD" || keyword === "INS.TAIL" || keyword === "REM") {
		if (rest !== "") return makeError("syntax", lineNum, "unexpected text after op");
		if (keyword === "REM") return { kind: "remove", sourceLine: lineNum };
		return { kind: keyword === "INS.HEAD" ? "insert-head" : "insert-tail", sourceLine: lineNum, body: [] };
	}
	if (keyword === "MV") {
		if (rest.length === 0) return makeError("syntax", lineNum, "missing move destination");
		if (rest.length > MAX_NAME_LEN) return makeError("limit", lineNum, "move destination too long");
		return { kind: "move", sourceLine: lineNum, to: rest };
	}
	const anchor = parseAnchor(rest, lineNum);
	if ("code" in anchor) return anchor;
	const kind =
		keyword === "SWAP.BLK"
			? "replace-block"
			: keyword === "DEL.BLK"
				? "delete-block"
				: keyword === "INS.BLK.POST"
					? "insert-after-block"
					: keyword === "INS.POST"
						? "insert-after"
						: "insert-before";
	return { kind, sourceLine: lineNum, anchor, body: [] };
}

function anchorsOf(draft: Draft): readonly HashAnchor[] {
	switch (draft.kind) {
		case "replace":
		case "delete":
			return [draft.start, draft.end];
		case "insert-before":
		case "insert-after":
		case "insert-after-block":
		case "replace-block":
		case "delete-block":
			return [draft.anchor];
		default:
			return [];
	}
}

function finalizeEdits(
	drafts: readonly Draft[],
	path: string,
	lineDigests: Map<string, LineExpectationDraft>,
): FinalizedSection | HashProposalError {
	const edits: HashProposalEdit[] = [];
	const consumedSpans: Array<{ start: number; end: number }> = [];
	const blockAnchorLines = new Set<number>();
	let editUnits = 0;
	let spanUnits = 0;
	let sawFileOp = false;
	for (const draft of drafts) {
		if (sawFileOp) return makeError("syntax", draft.sourceLine, "file op must be last");
		for (const anchor of anchorsOf(draft)) {
			const key = `${anchor.line}\0${path}`;
			const known = lineDigests.get(key);
			if (known !== undefined && known.digest !== anchor.digest) {
				return makeError("hash-conflict", draft.sourceLine, "conflicting line hash");
			}
			if (known === undefined) lineDigests.set(key, { path, line: anchor.line, digest: anchor.digest });
		}
		switch (draft.kind) {
			case "replace":
			case "delete": {
				const span = draft.end.line - draft.start.line + 1;
				spanUnits += span;
				consumedSpans.push({ start: draft.start.line, end: draft.end.line });
				if (draft.kind === "replace") {
					const { sourceLine, start, end, body } = draft;
					edits.push({ kind: "replace", sourceLine, start, end, body });
					editUnits += span + body.length;
				} else {
					edits.push({ kind: "delete", sourceLine: draft.sourceLine, start: draft.start, end: draft.end });
					editUnits += span;
				}
				break;
			}
			case "replace-block":
			case "delete-block": {
				if (blockAnchorLines.has(draft.anchor.line)) {
					return makeError("overlap", draft.sourceLine, "duplicate block anchor");
				}
				blockAnchorLines.add(draft.anchor.line);
				if (draft.kind === "replace-block") {
					if (draft.body.length === 0) return makeError("payload", draft.sourceLine, "empty insert body");
					edits.push({
						kind: "replace-block",
						sourceLine: draft.sourceLine,
						anchor: draft.anchor,
						body: draft.body,
					});
					editUnits += draft.body.length;
				} else {
					edits.push({ kind: "delete-block", sourceLine: draft.sourceLine, anchor: draft.anchor });
					editUnits += 1;
				}
				break;
			}
			case "insert-before":
			case "insert-after":
			case "insert-after-block": {
				if (draft.body.length === 0) return makeError("payload", draft.sourceLine, "empty insert body");
				edits.push({ kind: draft.kind, sourceLine: draft.sourceLine, anchor: draft.anchor, body: draft.body });
				editUnits += draft.body.length;
				break;
			}
			case "insert-head":
			case "insert-tail": {
				if (draft.body.length === 0) return makeError("payload", draft.sourceLine, "empty insert body");
				edits.push({ kind: draft.kind, sourceLine: draft.sourceLine, body: draft.body });
				editUnits += draft.body.length;
				break;
			}
			case "remove": {
				edits.push({ kind: "remove", sourceLine: draft.sourceLine });
				sawFileOp = true;
				editUnits += 1;
				break;
			}
			case "move": {
				edits.push({ kind: "move", sourceLine: draft.sourceLine, to: draft.to });
				sawFileOp = true;
				editUnits += 1;
				break;
			}
			default: {
				const unreachable: never = draft;
				return unreachable;
			}
		}
	}
	if (spanUnits > MAX_SPAN) return makeError("limit", undefined, "concrete span exceeds limit");
	const ordered = [...consumedSpans].sort((a, b) => a.start - b.start);
	for (let i = 1; i < ordered.length; i++) {
		if (ordered[i].start <= ordered[i - 1].end) return makeError("overlap", undefined, "overlapping spans");
	}
	return { edits, editUnits, spanUnits };
}

function parseSection(
	lines: readonly string[],
	endIndex: number,
	headerIndex: number,
	headerLine: number,
	path: string,
	fileDigest: string,
	lineDigests: Map<string, LineExpectationDraft>,
): ParsedSection | HashProposalError {
	const drafts: Draft[] = [];
	let index = headerIndex + 1;
	let lineNum = headerLine + 1;
	while (index < endIndex && !lines[index].startsWith("[")) {
		const line = lines[index];
		if (line.length === 0) {
			index += 1;
			lineNum += 1;
			continue;
		}
		if (line.startsWith("+")) {
			if (drafts.length === 0) return makeError("payload", lineNum, "payload outside hunk");
			const last = drafts[drafts.length - 1];
			if (last.kind === "remove" || last.kind === "move")
				return makeError("payload", lineNum, "payload after file op");
			if (last.kind === "delete" || last.kind === "delete-block") {
				return makeError("payload", lineNum, "delete takes no body");
			}
			last.body.push(line.slice(1));
		} else {
			const draft = parseHunk(line, lineNum);
			if ("code" in draft) return draft;
			drafts.push(draft);
			if (drafts.length > MAX_HUNKS) return makeError("limit", lineNum, "hunks exceed limit");
		}
		index += 1;
		lineNum += 1;
	}
	if (drafts.length === 0) return makeError("syntax", headerLine, "section has no hunks");
	const finalized = finalizeEdits(drafts, path, lineDigests);
	if ("code" in finalized) return finalized;
	return {
		section: { path, digest: fileDigest, edits: finalized.edits },
		nextIndex: index,
		nextLineNum: lineNum,
		editUnits: finalized.editUnits,
		spanUnits: finalized.spanUnits,
	};
}

export function parseHashlineProposal(untrustedText: string): HashProposalParseResult {
	if (hasLoneSurrogate(untrustedText)) return failure("encoding", undefined, "ill-formed UTF-16");
	if (utf8Bytes(untrustedText).length > MAX_PATCH_BYTES) return failure("too-large", undefined, "patch too large");
	const lines = untrustedText.replace(/\r\n?/g, "\n").split("\n");
	let upper = lines.length;
	if (upper > 1 && lines[upper - 1] === "") upper -= 1;
	if (lines[0] !== BEGIN_MARKER) return failure("syntax", 1, "missing begin patch");
	const endIndex = upper - 1;
	if (endIndex < 1 || lines[endIndex] !== END_MARKER) {
		const seen = lines.indexOf(END_MARKER);
		return seen >= 0 && seen < endIndex
			? failure("syntax", seen + 2, "trailing data after end patch")
			: failure("syntax", upper, "missing end patch");
	}
	const sections: HashProposalSection[] = [];
	const fileDigests = new Map<string, string>();
	const lineDigests = new Map<string, LineExpectationDraft>();
	let index = 1;
	let lineNum = 2;
	let editUnits = 0;
	let spanUnits = 0;
	while (index < endIndex) {
		const line = lines[index];
		if (line.length === 0) {
			index += 1;
			lineNum += 1;
			continue;
		}
		if (!line.startsWith("[")) return failure("syntax", lineNum, "expected file header");
		const header = HEADER_RE.exec(line);
		if (header === null) return failure("syntax", lineNum, "bad file header");
		const path = header[1];
		const digestHex = header[2];
		if (path.length === 0) return failure("syntax", lineNum, "empty path");
		if (path.length > MAX_NAME_LEN) return failure("limit", lineNum, "path too long");
		if (sections.length >= MAX_SECTIONS) return failure("limit", lineNum, "sections exceed limit");
		const known = fileDigests.get(path);
		if (known !== undefined && known !== digestHex) return failure("hash-conflict", lineNum, "conflicting file hash");
		fileDigests.set(path, digestHex);
		const parsed = parseSection(lines, endIndex, index, lineNum, path, digestHex, lineDigests);
		if ("code" in parsed) return failure(parsed.code, parsed.line, parsed.message);
		sections.push(parsed.section);
		editUnits += parsed.editUnits;
		spanUnits += parsed.spanUnits;
		if (editUnits > MAX_EDITS) return failure("limit", undefined, "edits exceed limit");
		if (spanUnits > MAX_SPAN) return failure("limit", undefined, "spans exceed limit");
		index = parsed.nextIndex;
		lineNum = parsed.nextLineNum;
	}
	if (sections.length === 0) return failure("syntax", undefined, "patch has no sections");
	const expectedFileHashes = Array.from(fileDigests, ([path, digest]) => ({ path, digest }));
	return success({ sections, expectedFileHashes, expectedLineHashes: [...lineDigests.values()] });
}
