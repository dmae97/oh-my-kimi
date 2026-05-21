import { ABORT_MARKER, ABORT_WARNING, BEGIN_PATCH_MARKER, END_PATCH_MARKER, RANGE_INTERIOR_HASH } from "./constants";
import { describeAnchorExamples, HL_EDIT_SEP, HL_HASH_CAPTURE_RE_RAW } from "./hash";
import type { Anchor, HashlineCursor, HashlineEdit } from "./types";

const LID_CAPTURE_RE = new RegExp(`^${HL_HASH_CAPTURE_RE_RAW}$`);

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
		throw new Error(
			`line ${lineNum}: explicit ranges are required for delete/replace. ` +
				`Repeat the same anchor on both sides for a one-line edit (for example, ` +
				`${describeAnchorExamples("119")}..${describeAnchorExamples("119")}); ` +
				`got ${JSON.stringify(raw)}.`,
		);
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

const INSERT_BEFORE_OP_RE = /^<\s*(\S+)$/;
const INSERT_AFTER_OP_RE = /^\+\s*(\S+)$/;
const DELETE_OP_RE = /^-\s*(\S+)$/;
const REPLACE_OP_RE = /^=\s*(\S+)$/;

export function cloneCursor(cursor: HashlineCursor): HashlineCursor {
	if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
	if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}
/**
 * Returns true when every non-empty payload line looks like the `~ TEXT` readability-padding
 * typo: exactly one leading space followed by a non-space character (or a bare single space).
 *
 * Indented file content (Python 4-space, YAML/JSON/Markdown 2-space, etc.) starts with two or
 * more leading spaces, so this heuristic ignores legitimate indentation while still flagging
 * the common `~ beta` mistake that silently corrupts file content with a stray space.
 */
function hasUniformSeparatorPadding(payload: string[]): boolean {
	let any = false;
	for (const text of payload) {
		if (text.length === 0) continue;
		if (text.charCodeAt(0) !== 0x20) return false;
		// Two or more leading spaces is real indentation, not separator padding.
		if (text.length > 1 && text.charCodeAt(1) === 0x20) return false;
		any = true;
	}
	return any;
}

/**
 * File extensions where leading single-space indentation is plausible legitimate file content
 * (off-side-rule languages, structured-indent data formats, prose with continuation indent).
 * For these we suppress the separator-padding warning entirely — the heuristic's false-positive
 * cost on a real edit outweighs the rare chance it catches a `~ TEXT` typo.
 */
const INDENT_SENSITIVE_EXTS: Record<string, true> = {
	".py": true,
	".pyi": true,
	".pyx": true,
	".pyw": true,
	".yml": true,
	".yaml": true,
	".md": true,
	".mdx": true,
	".markdown": true,
	".rst": true,
	".adoc": true,
	".asciidoc": true,
	".toml": true,
	".json": true,
	".jsonc": true,
	".json5": true,
	".ndjson": true,
	".jsonl": true,
	".tf": true,
	".tfvars": true,
	".hcl": true,
	".nix": true,
	".coffee": true,
	".litcoffee": true,
	".haml": true,
	".slim": true,
	".pug": true,
	".jade": true,
	".sass": true,
	".styl": true,
	".nim": true,
	".cr": true,
	".elm": true,
	".fs": true,
	".fsi": true,
	".fsx": true,
};

function isIndentationSensitivePath(path: string | undefined): boolean {
	if (!path) return false;
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const dot = path.lastIndexOf(".");
	if (dot <= slash) return false;
	const ext = path.slice(dot).toLowerCase();
	return INDENT_SENSITIVE_EXTS[ext] === true;
}

function collectPayload(
	lines: string[],
	startIndex: number,
	opLineNum: number,
	requirePayload: boolean,
	checkPadding: boolean,
): { payload: string[]; nextIndex: number; paddingWarning?: string } {
	const payload: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const line = lines[index];
		if (line.startsWith(HL_EDIT_SEP)) {
			payload.push(line.slice(HL_EDIT_SEP.length).trimEnd());
			index++;
			continue;
		}
		// Silently recover from a missing payload prefix on an otherwise blank
		// line: if more payload follows (possibly past further blanks), treat
		// each intervening blank as an empty `${HL_EDIT_SEP}` payload line.
		// Additionally, when the op explicitly requires payload (`+`/`<`) and
		// we have not collected any yet, accept the blank(s) themselves as the
		// empty payload — common typo of forgetting the `${HL_EDIT_SEP}` prefix
		// when inserting a blank line.
		if (line.length === 0) {
			let lookahead = index + 1;
			while (lookahead < lines.length && lines[lookahead].length === 0) {
				lookahead++;
			}
			const followedByPayload = lookahead < lines.length && lines[lookahead].startsWith(HL_EDIT_SEP);
			const acceptBareBlank = requirePayload && payload.length === 0;
			if (followedByPayload || acceptBareBlank) {
				for (let j = index; j < lookahead; j++) payload.push("");
				index = lookahead;
				continue;
			}
		}
		break;
	}
	if (payload.length === 0 && requirePayload) {
		throw new Error(`line ${opLineNum}: + and < operations require at least one ${HL_EDIT_SEP}TEXT payload line.`);
	}
	const paddingWarning =
		checkPadding && hasUniformSeparatorPadding(payload)
			? `line ${opLineNum}: every payload line begins with exactly one space before non-space content, ` +
				`which looks like a readability gap after "${HL_EDIT_SEP}". The space becomes file content. ` +
				`Drop it unless the file genuinely uses a one-space indent.`
			: undefined;
	return { payload, nextIndex: index, paddingWarning };
}

export function parseHashline(diff: string, opts: ParseHashlineOptions = {}): HashlineEdit[] {
	return parseHashlineWithWarnings(diff, opts).edits;
}

export interface ParseHashlineOptions {
	/** File path the diff targets. Used to suppress indent-sensitive false-positive warnings. */
	path?: string;
}

export function parseHashlineWithWarnings(
	diff: string,
	opts: ParseHashlineOptions = {},
): { edits: HashlineEdit[]; warnings: string[] } {
	const edits: HashlineEdit[] = [];
	const warnings: string[] = [];
	const lines = diff.split(/\r?\n/);
	const checkPadding = !isIndentationSensitivePath(opts.path);
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
		if (line.startsWith(HL_EDIT_SEP)) {
			throw new Error(`line ${lineNum}: payload line has no preceding +, <, or = operation.`);
		}

		const insertBeforeMatch = INSERT_BEFORE_OP_RE.exec(line);
		if (insertBeforeMatch) {
			const cursor = parseInsertTarget(insertBeforeMatch[1], lineNum, "before");
			const { payload, nextIndex, paddingWarning } = collectPayload(lines, i + 1, lineNum, true, checkPadding);
			if (paddingWarning) warnings.push(paddingWarning);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const insertAfterMatch = INSERT_AFTER_OP_RE.exec(line);
		if (insertAfterMatch) {
			const cursor = parseInsertTarget(insertAfterMatch[1], lineNum, "after");
			const { payload, nextIndex, paddingWarning } = collectPayload(lines, i + 1, lineNum, true, checkPadding);
			if (paddingWarning) warnings.push(paddingWarning);
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
			const { payload, nextIndex, paddingWarning } = collectPayload(lines, i + 1, lineNum, false, checkPadding);
			if (paddingWarning) warnings.push(paddingWarning);
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
			`line ${lineNum}: unrecognized op. Use < ANCHOR (insert before), + ANCHOR (insert after), - A..B (delete), = A..B (replace), or "${HL_EDIT_SEP}TEXT" payload lines. ` +
				`Got ${JSON.stringify(line)}.`,
		);
	}

	return { edits, warnings };
}
