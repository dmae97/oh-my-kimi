/**
 * Apply a parsed list of {@link Edit}s to a text body and return the
 * post-edit lines plus any diagnostic warnings. Pure function: no FS, no
 * mutation of the input.
 *
 * Replacement groups are first normalized by {@link repairReplacementBoundaries},
 * which absorbs common model mistakes where a payload restates unchanged range
 * boundaries or duplicates/drops structural closers.
 */
import { UNRESOLVED_BLOCK_INTERNAL } from "./messages";
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

function getCursorAnchors(cursor: Cursor): Anchor[] {
	return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
}

function getEditAnchors(edit: AppliedEdit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
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

function cloneAppliedEdit(edit: AppliedEdit, index: number): AppliedEdit {
	if (edit.kind === "delete") return { ...edit, anchor: { ...edit.anchor }, index };
	return { ...edit, cursor: cloneCursor(edit.cursor), index };
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
				: entry.edit.cursor.kind === "before_anchor" || entry.edit.cursor.kind === "after_anchor"
					? entry.edit.cursor.anchor.line
					: 0;
		const bucket = byLine.get(line);
		if (bucket) bucket.push(entry);
		else byLine.set(line, [entry]);
	}
	return byLine;
}

// ═══════════════════════════════════════════════════════════════════════════
// Replacement-boundary repair
//
// Models routinely miscount a replacement range's edges. Sometimes the payload
// re-states unchanged lines that still live on both sides of the range
// (duplicating a function header and final statement); sometimes it only
// re-states or omits a structural closer, which leaves delimiter balance broken.
//
// A balance-neutral boundary-echo repair fires only when both the leading and
// trailing payload edges are exact copies of the surviving lines outside the
// range. One-sided content echoes are left alone unless delimiter-balance repair
// proves they are duplicated structural boundaries. This preserves intended
// duplicate statements while absorbing the common "body includes the unchanged
// wrapper" mistake.

/** A line that is nothing but closing delimiters: `}`, `)`, `];`, `})`, `},`. */
const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

interface DelimiterBalance {
	paren: number;
	bracket: number;
	brace: number;
}

/**
 * Net `()` / `[]` / `{}` delta across `lines`, skipping delimiters inside line
 * comments (`//`), block comments, and string/template literals. Block-comment
 * and backtick-template state carry across lines; `"` / `'` reset at EOL since
 * they cannot span lines. Deliberately language-light: constructs it cannot
 * classify (e.g. regex literals) are counted naively, which can only suppress a
 * repair (the safe direction), never force one.
 */
function computeDelimiterBalance(lines: readonly string[]): DelimiterBalance {
	const balance: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 };
	let inBlockComment = false;
	let quote = "";
	for (const line of lines) {
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inBlockComment) {
				if (ch === "*" && line[i + 1] === "/") {
					inBlockComment = false;
					i++;
				}
				continue;
			}
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				continue;
			}
			if (ch === "/" && line[i + 1] === "/") break;
			if (ch === "/" && line[i + 1] === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			switch (ch) {
				case "(":
					balance.paren++;
					break;
				case ")":
					balance.paren--;
					break;
				case "[":
					balance.bracket++;
					break;
				case "]":
					balance.bracket--;
					break;
				case "{":
					balance.brace++;
					break;
				case "}":
					balance.brace--;
					break;
			}
		}
		// `"` / `'` cannot span lines; only backtick templates and block comments do.
		if (quote === '"' || quote === "'") quote = "";
	}
	return balance;
}

function balanceDelta(a: DelimiterBalance, b: DelimiterBalance): DelimiterBalance {
	return { paren: a.paren - b.paren, bracket: a.bracket - b.bracket, brace: a.brace - b.brace };
}

function balanceNegate(a: DelimiterBalance): DelimiterBalance {
	return { paren: -a.paren, bracket: -a.bracket, brace: -a.brace };
}

function balanceEqual(a: DelimiterBalance, b: DelimiterBalance): boolean {
	return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace;
}

function balanceIsZero(a: DelimiterBalance): boolean {
	return a.paren === 0 && a.bracket === 0 && a.brace === 0;
}

interface ReplacementGroup {
	/** Positions in the edit array of the payload inserts, in payload order. */
	insertIndices: number[];
	/** Positions in the edit array of the range deletes, ascending by line. */
	deleteIndices: number[];
	payload: string[];
	/** First deleted line (1-indexed). */
	startLine: number;
	/** Last deleted line (1-indexed). */
	endLine: number;
}

/**
 * Detect a replacement group starting at `start`: a run of `before_anchor`
 * replacement inserts sharing one source op line, immediately followed by the
 * contiguous range deletes for that same op. Mirrors how the parser lowers an
 * `replace N..M:` hunk with a body.
 */
function findReplacementGroup(edits: readonly AppliedEdit[], start: number): ReplacementGroup | undefined {
	const first = edits[start];
	if (first?.kind !== "insert" || first.mode !== "replacement" || first.cursor.kind !== "before_anchor") {
		return undefined;
	}
	const { lineNum } = first;
	const anchorLine = first.cursor.anchor.line;
	const insertIndices: number[] = [];
	const payload: string[] = [];
	let i = start;
	for (; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.kind !== "insert" || edit.mode !== "replacement" || edit.lineNum !== lineNum) break;
		if (edit.cursor.kind !== "before_anchor" || edit.cursor.anchor.line !== anchorLine) break;
		insertIndices.push(i);
		payload.push(edit.text);
	}
	const deleteIndices: number[] = [];
	let expectedLine = anchorLine;
	for (; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.kind !== "delete" || edit.lineNum !== lineNum || edit.anchor.line !== expectedLine) break;
		deleteIndices.push(i);
		expectedLine++;
	}
	if (deleteIndices.length === 0) return undefined;
	return {
		insertIndices,
		deleteIndices,
		payload,
		startLine: anchorLine,
		endLine: anchorLine + deleteIndices.length - 1,
	};
}

/**
 * Largest `k` such that the payload's last `k` lines exactly equal the `k`
 * surviving file lines just below the range AND dropping them zeroes `delta`.
 * Single-line drops are limited to pure structural closers.
 */
function findDuplicateSuffix(group: ReplacementGroup, fileLines: readonly string[], delta: DelimiterBalance): number {
	const { payload, endLine } = group;
	const maxK = Math.min(payload.length, fileLines.length - endLine);
	for (let k = maxK; k >= 1; k--) {
		let matches = true;
		for (let t = 0; t < k; t++) {
			if (payload[payload.length - k + t] !== fileLines[endLine + t]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		if (k === 1 && !STRUCTURAL_CLOSER_RE.test(payload[payload.length - 1])) continue;
		if (balanceEqual(computeDelimiterBalance(payload.slice(payload.length - k)), delta)) return k;
	}
	return 0;
}

/**
 * Largest `j` such that the payload's first `j` lines exactly equal the `j`
 * surviving file lines just above the range AND dropping them zeroes `delta`.
 */
function findDuplicatePrefix(group: ReplacementGroup, fileLines: readonly string[], delta: DelimiterBalance): number {
	const { payload, startLine } = group;
	const maxJ = Math.min(payload.length, startLine - 1);
	for (let j = maxJ; j >= 1; j--) {
		let matches = true;
		for (let t = 0; t < j; t++) {
			if (payload[t] !== fileLines[startLine - 1 - j + t]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		if (j === 1 && !STRUCTURAL_CLOSER_RE.test(payload[0])) continue;
		if (balanceEqual(computeDelimiterBalance(payload.slice(0, j)), delta)) return j;
	}
	return 0;
}

/**
 * Smallest `m` such that the range's last `m` deleted lines are all pure
 * structural closers and sparing them (keeping instead of deleting) zeroes
 * `delta`. The mirror mistake: a range that swallows a closing delimiter the
 * payload never restates.
 */
function findDroppedSuffixClosers(
	group: ReplacementGroup,
	fileLines: readonly string[],
	delta: DelimiterBalance,
): number {
	const wanted = balanceNegate(delta);
	const maxM = group.deleteIndices.length;
	for (let m = 1; m <= maxM; m++) {
		if (!STRUCTURAL_CLOSER_RE.test(fileLines[group.endLine - m] ?? "")) break;
		if (balanceEqual(computeDelimiterBalance(fileLines.slice(group.endLine - m, group.endLine)), wanted)) return m;
	}
	return 0;
}

interface BoundaryEcho {
	leading: number;
	trailing: number;
}

function hasNonWhitespace(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 32) return true;
	}
	return false;
}

function countDuplicateLeadingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
	const { payload, startLine } = group;
	const max = Math.min(payload.length, startLine - 1);
	for (let count = max; count >= 1; count--) {
		let matches = true;
		let hasContent = false;
		for (let offset = 0; offset < count; offset++) {
			const line = payload[offset];
			if (line !== fileLines[startLine - 1 - count + offset]) {
				matches = false;
				break;
			}
			hasContent ||= hasNonWhitespace(line);
		}
		if (matches && hasContent) return count;
	}
	return 0;
}

function countDuplicateTrailingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
	const { payload, endLine } = group;
	const max = Math.min(payload.length, fileLines.length - endLine);
	for (let count = max; count >= 1; count--) {
		let matches = true;
		let hasContent = false;
		for (let offset = 0; offset < count; offset++) {
			const line = payload[payload.length - count + offset];
			if (line !== fileLines[endLine + offset]) {
				matches = false;
				break;
			}
			hasContent ||= hasNonWhitespace(line);
		}
		if (matches && hasContent) return count;
	}
	return 0;
}

function findBoundaryEcho(group: ReplacementGroup, fileLines: readonly string[]): BoundaryEcho | undefined {
	const leadingMax = countDuplicateLeadingBoundaryLines(group, fileLines);
	if (leadingMax === 0) return undefined;
	const trailingMax = countDuplicateTrailingBoundaryLines(group, fileLines);
	if (trailingMax === 0) return undefined;
	// Bail when every payload line could be claimed by a boundary echo: any
	// repair would strip explicit replacement content with no signal that the
	// payload was a mistake rather than an intentional duplication.
	if (leadingMax + trailingMax >= group.payload.length) return undefined;
	return { leading: leadingMax, trailing: trailingMax };
}

function describeBoundaryEchoRepair(group: ReplacementGroup, echo: BoundaryEcho): string {
	return (
		`Auto-repaired a replacement boundary echo at line ${group.startLine}: ` +
		`dropped ${echo.leading} leading and ${echo.trailing} trailing payload line(s) already present outside the range. ` +
		`Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range.`
	);
}

function describeBoundaryRepair(group: ReplacementGroup, action: string): string {
	return (
		`Auto-repaired a delimiter-balance mismatch in the replacement at line ${group.startLine}: ${action}. ` +
		`Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`
	);
}

/**
 * Normalize replacement groups so common off-by-one boundaries do not duplicate
 * unchanged surrounding lines or structural closers. Returns the repaired edit
 * list plus one warning per repaired group.
 */
function repairReplacementBoundaries(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
): {
	edits: AppliedEdit[];
	warnings: string[];
} {
	const out: AppliedEdit[] = [];
	const warnings: string[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = findReplacementGroup(edits, i);
		if (!group) {
			out.push(edits[i]);
			i++;
			continue;
		}
		const inserts = group.insertIndices.map(idx => edits[idx]);
		const deletes = group.deleteIndices.map(idx => edits[idx]);
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;

		const boundaryEcho = findBoundaryEcho(group, fileLines);
		if (boundaryEcho) {
			warnings.push(describeBoundaryEchoRepair(group, boundaryEcho));
			out.push(...inserts.slice(boundaryEcho.leading, inserts.length - boundaryEcho.trailing), ...deletes);
			continue;
		}

		const delta = balanceDelta(
			computeDelimiterBalance(group.payload),
			computeDelimiterBalance(fileLines.slice(group.startLine - 1, group.endLine)),
		);
		if (balanceIsZero(delta)) {
			out.push(...inserts, ...deletes);
			continue;
		}

		const dupSuffix = findDuplicateSuffix(group, fileLines, delta);
		if (dupSuffix > 0) {
			warnings.push(
				describeBoundaryRepair(
					group,
					`dropped ${dupSuffix} duplicated trailing payload line(s) already present below the range`,
				),
			);
			out.push(...inserts.slice(0, inserts.length - dupSuffix), ...deletes);
			continue;
		}
		const dupPrefix = findDuplicatePrefix(group, fileLines, delta);
		if (dupPrefix > 0) {
			warnings.push(
				describeBoundaryRepair(
					group,
					`dropped ${dupPrefix} duplicated leading payload line(s) already present above the range`,
				),
			);
			out.push(...inserts.slice(dupPrefix), ...deletes);
			continue;
		}
		const droppedClosers = findDroppedSuffixClosers(group, fileLines, delta);
		if (droppedClosers > 0) {
			warnings.push(
				describeBoundaryRepair(
					group,
					`kept ${droppedClosers} structural closing line(s) the range deleted without restating`,
				),
			);
			out.push(...inserts, ...deletes.slice(0, deletes.length - droppedClosers));
			continue;
		}
		out.push(...inserts, ...deletes);
	}
	return { edits: out, warnings };
}

/**
 * Apply a parsed list of edits to a text body. Pure function — no I/O.
 *
 * Returns the post-edit text and the first changed line number (1-indexed).
 * Throws if an anchor is out of bounds.
 */
export function applyEdits(text: string, edits: readonly Edit[]): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined };

	// Block edits are deferred until `resolveBlockEdits` expands them into
	// concrete inserts + deletes. Reaching the applier with one still present
	// is an internal wiring bug, not authored-input error.
	for (const edit of edits) {
		if (edit.kind === "block") throw new Error(UNRESOLVED_BLOCK_INTERNAL);
	}
	const appliedEdits = edits as readonly AppliedEdit[];

	const fileLines = text.split("\n");
	const lineOrigins: LineOrigin[] = fileLines.map(() => "original");

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const targetEdits = appliedEdits.map((edit, index) => cloneAppliedEdit(edit, index));
	validateLineBounds(targetEdits, fileLines);
	const { edits: repaired, warnings } = repairReplacementBoundaries(targetEdits, fileLines);

	// Partition edits into bof, eof, and anchor-targeted buckets.
	const bofLines: string[] = [];
	const eofLines: string[] = [];
	const anchorEdits: IndexedEdit[] = [];
	repaired.forEach((edit, idx) => {
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
		const beforeInsertLines: string[] = [];
		const afterInsertLines: string[] = [];
		const replacementLines: string[] = [];
		let deleteLine = false;

		for (const { edit } of bucket) {
			if (isReplacementInsert(edit)) {
				replacementLines.push(edit.text);
			} else if (edit.kind === "insert" && edit.cursor.kind === "after_anchor") {
				afterInsertLines.push(edit.text);
			} else if (edit.kind === "insert") {
				beforeInsertLines.push(edit.text);
			} else if (edit.kind === "delete") {
				deleteLine = true;
			}
		}
		if (
			beforeInsertLines.length === 0 &&
			replacementLines.length === 0 &&
			afterInsertLines.length === 0 &&
			!deleteLine
		)
			continue;

		const replacement = deleteLine
			? [...beforeInsertLines, ...replacementLines, ...afterInsertLines]
			: [...beforeInsertLines, ...replacementLines, currentLine, ...afterInsertLines];
		const origins: LineOrigin[] = [];
		for (let i = 0; i < beforeInsertLines.length; i++) origins.push("insert");
		for (let i = 0; i < replacementLines.length; i++) origins.push(deleteLine ? "replacement" : "insert");
		if (!deleteLine) origins.push(lineOrigins[idx] ?? "original");
		for (let i = 0; i < afterInsertLines.length; i++) origins.push("insert");

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
		...(warnings.length > 0 ? { warnings } : {}),
	};
}
