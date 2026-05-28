/**
 * Apply a parsed list of {@link Edit}s to a text body and return the
 * post-edit lines. Pure function: no FS, no mutation of the input.
 */
import { cloneCursor } from "./tokenizer";
import type { Anchor, ApplyResult, Cursor, Edit } from "./types";

type LineOrigin = "original" | "insert" | "replacement";

type InsertEdit = Extract<Edit, { kind: "insert" }>;
type DeleteEdit = Extract<Edit, { kind: "delete" }>;
type AppliedEdit = InsertEdit | DeleteEdit;

interface IndexedEdit {
	edit: AppliedEdit;
	idx: number;
}

function isReplacementInsert(edit: Edit): edit is InsertEdit & { mode: "replacement" } {
	return edit.kind === "insert" && edit.mode === "replacement";
}

function rangeAnchors(start: Anchor, end: Anchor): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = start.line; line <= end.line; line++) anchors.push({ line });
	return anchors;
}

function getCursorAnchors(cursor: Cursor): Anchor[] {
	return cursor.kind === "before_anchor" ? [cursor.anchor] : [];
}

function getEditAnchors(edit: Edit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	if (edit.kind === "repeat")
		return [...getCursorAnchors(edit.cursor), ...rangeAnchors(edit.range.start, edit.range.end)];
	return getCursorAnchors(edit.cursor);
}

/**
 * Verify every anchored edit points at an existing line. File-version binding is
 * checked once per section via the header hash before this function runs.
 */
function validateLineBounds(edits: AppliedEdit[], fileLines: string[]): void {
	for (const edit of edits) {
		for (const anchor of getEditAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
		}
	}
}

function assertLineExists(line: number, fileLines: string[]): void {
	if (line < 1 || line > fileLines.length) {
		throw new Error(`Line ${line} does not exist (file has ${fileLines.length} lines)`);
	}
}

function cloneAppliedEdit(edit: AppliedEdit, index: number): AppliedEdit {
	if (edit.kind === "delete") return { ...edit, anchor: { ...edit.anchor }, index };
	return { ...edit, cursor: cloneCursor(edit.cursor), index };
}

function expandRepeatEdits(edits: Edit[], fileLines: string[]): AppliedEdit[] {
	const expanded: AppliedEdit[] = [];
	for (const edit of edits) {
		if (edit.kind !== "repeat") {
			expanded.push(cloneAppliedEdit(edit, expanded.length));
			continue;
		}
		if (edit.range.end.line < edit.range.start.line) {
			throw new Error(
				`line ${edit.lineNum}: range ${edit.range.start.line}-${edit.range.end.line} ends before it starts.`,
			);
		}
		for (let line = edit.range.start.line; line <= edit.range.end.line; line++) {
			assertLineExists(line, fileLines);
			expanded.push({
				kind: "insert",
				cursor: cloneCursor(edit.cursor),
				text: fileLines[line - 1] ?? "",
				lineNum: edit.lineNum,
				index: expanded.length,
				...(edit.mode === undefined ? {} : { mode: edit.mode }),
			});
		}
	}
	return expanded;
}

function insertAtStart(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): void {
	if (lines.length === 0) return;
	const origins = lines.map((): LineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return;
	}
	fileLines.splice(0, 0, ...lines);
	lineOrigins.splice(0, 0, ...origins);
}

function insertAtEnd(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): number | undefined {
	if (lines.length === 0) return undefined;
	const origins = lines.map((): LineOrigin => "insert");
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

/**
 * Apply a parsed list of edits to a text body. Pure function — no I/O.
 *
 * Returns the post-edit text and the first changed line number (1-indexed).
 * Throws if an anchor is out of bounds.
 */
export function applyEdits(text: string, edits: Edit[]): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined };

	const fileLines = text.split("\n");
	const lineOrigins: LineOrigin[] = fileLines.map(() => "original");

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const targetEdits = expandRepeatEdits(edits, fileLines);
	validateLineBounds(targetEdits, fileLines);

	// Partition edits into BOF, EOF, and anchor-targeted buckets.
	const bofLines: string[] = [];
	const eofLines: string[] = [];
	const anchorEdits: IndexedEdit[] = [];
	targetEdits.forEach((edit, idx) => {
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
		const insertLines: string[] = [];
		const replacementLines: string[] = [];
		let deleteLine = false;

		for (const { edit } of bucket) {
			if (isReplacementInsert(edit)) {
				replacementLines.push(edit.text);
			} else if (edit.kind === "insert") {
				insertLines.push(edit.text);
			} else if (edit.kind === "delete") {
				deleteLine = true;
			}
		}
		if (insertLines.length === 0 && replacementLines.length === 0 && !deleteLine) continue;

		const replacement = deleteLine
			? [...insertLines, ...replacementLines]
			: [...insertLines, ...replacementLines, currentLine];
		const origins: LineOrigin[] = [];
		for (let i = 0; i < insertLines.length; i++) origins.push("insert");
		for (let i = 0; i < replacementLines.length; i++) origins.push(deleteLine ? "replacement" : "insert");
		if (!deleteLine) origins.push(lineOrigins[idx] ?? "original");

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
		text: fileLines.join("\n"),
		firstChangedLine,
	};
}
