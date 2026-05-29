/**
 * Apply a parsed list of {@link Edit}s to a text body and return the
 * post-edit lines plus any diagnostic warnings. Pure function: no FS, no
 * mutation of the input.
 *
 * Replacement groups are first normalized by {@link repairBoundaryBalance},
 * which fixes the common model mistake of a payload that duplicates or drops
 * the closing delimiter bordering the range (balance-validated; see below).
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

function getCursorAnchors(cursor: Cursor): Anchor[] {
	return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
}

function getEditAnchors(edit: Edit): Anchor[] {
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
// Boundary-balance repair
//
// Models routinely miscount a replacement range's edges. The payload either
// re-states a closing delimiter that still lives just outside the range
// (producing a DUPLICATE `}` / `);` / `]`) or the range deletes a closer the
// payload never restates (DROPPING it). Both are the same defect — a
// replacement whose payload does not preserve the deleted region's delimiter
// balance — and both leave the file syntactically broken.
//
// A repair fires only when (a) the group's payload balance differs from the
// deleted region's balance and (b) one boundary operation drives that
// difference to exactly zero while leaving the surrounding text byte-identical.
// The operation only ever drops an exact multi-line boundary echo or a single
// pure structural-closer line, or spares a deleted pure structural-closer line,
// so content lines are never moved or lost. Balance-preserving edits are left
// strictly alone.

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

function describeBoundaryRepair(group: ReplacementGroup, action: string): string {
	return (
		`Auto-repaired a delimiter-balance mismatch in the replacement at line ${group.startLine}: ${action}. ` +
		`Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`
	);
}

/**
 * Normalize each replacement group so its payload preserves the deleted
 * region's delimiter balance. See the section header for the contract. Returns
 * the (possibly trimmed) edit list plus one warning per repaired group.
 */
function repairBoundaryBalance(
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
export function applyEdits(text: string, edits: Edit[]): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined };

	const fileLines = text.split("\n");
	const lineOrigins: LineOrigin[] = fileLines.map(() => "original");

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const targetEdits = edits.map((edit, index) => cloneAppliedEdit(edit, index));
	validateLineBounds(targetEdits, fileLines);
	const { edits: repaired, warnings } = repairBoundaryBalance(targetEdits, fileLines);

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
