import { HashlineMismatchError } from "./anchors";
import { RANGE_INTERIOR_HASH } from "./constants";
import { computeLineHash } from "./hash";
import { cloneCursor } from "./parser";
import type { Anchor, HashlineApplyOptions, HashlineCursor, HashlineEdit, HashMismatch } from "./types";

export interface HashlineApplyResult {
	lines: string;
	firstChangedLine?: number;
	warnings?: string[];
	noopEdits?: HashlineNoopEdit[];
}

export interface HashlineNoopEdit {
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

type HashlineDeleteEdit = Extract<HashlineEdit, { kind: "delete" }>;

interface HashlineReplacementGroup {
	startIndex: number;
	endIndex: number;
	sourceLineNum: number;
	replacement: string[];
	deletes: HashlineDeleteEdit[];
}

function getHashlineEditAnchors(edit: HashlineEdit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	if (edit.cursor.kind === "before_anchor") return [edit.cursor.anchor];
	if (edit.cursor.kind === "after_anchor") return [edit.cursor.anchor];
	return [];
}

/**
 * Verify every anchor's hash. Any mismatch is reported as a `HashMismatch`;
 * there is no auto-rebase. Callers are expected to surface mismatches as
 * `HashlineMismatchError` so the model re-reads and re-anchors.
 */
function validateHashlineAnchors(edits: HashlineEdit[], fileLines: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	for (const edit of edits) {
		for (const anchor of getHashlineEditAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
			if (anchor.hash === RANGE_INTERIOR_HASH) continue;

			const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1] ?? "");
			if (actualHash === anchor.hash) continue;

			mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
		}
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

function getAnchorTargetLine(edit: HashlineEdit): number | undefined {
	if (edit.kind === "delete") return edit.anchor.line;
	if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") return edit.cursor.anchor.line;
	return undefined;
}

function collectAnchorTargetLines(edits: HashlineEdit[]): Set<number> {
	const lines = new Set<number>();
	for (const edit of edits) {
		const line = getAnchorTargetLine(edit);
		if (line !== undefined) lines.add(line);
	}
	return lines;
}

function findReplacementGroup(edits: HashlineEdit[], startIndex: number): HashlineReplacementGroup | undefined {
	const first = edits[startIndex];
	if (first?.kind !== "insert" || first.cursor.kind !== "before_anchor") return undefined;

	const sourceLineNum = first.lineNum;
	const replacement: string[] = [];
	let index = startIndex;
	while (index < edits.length) {
		const edit = edits[index];
		if (edit.kind !== "insert" || edit.lineNum !== sourceLineNum || edit.cursor.kind !== "before_anchor") break;
		replacement.push(edit.text);
		index++;
	}

	const deletes: HashlineDeleteEdit[] = [];
	while (index < edits.length) {
		const edit = edits[index];
		if (edit.kind !== "delete" || edit.lineNum !== sourceLineNum) break;
		deletes.push(edit);
		index++;
	}
	if (deletes.length === 0) return undefined;

	const startLine = deletes[0].anchor.line;
	for (let offset = 0; offset < deletes.length; offset++) {
		if (deletes[offset].anchor.line !== startLine + offset) return undefined;
	}
	const cursorLine = first.cursor.anchor.line;
	if (cursorLine !== startLine) return undefined;

	return { startIndex, endIndex: index - 1, sourceLineNum, replacement, deletes };
}

function countMatchingPrefixBlock(fileLines: string[], startLine: number, replacement: string[]): number {
	const max = Math.min(replacement.length, startLine - 1);
	for (let count = max; count >= 2; count--) {
		let matches = true;
		for (let offset = 0; offset < count; offset++) {
			if (fileLines[startLine - count - 1 + offset] !== replacement[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return count;
	}
	return 0;
}

function countMatchingSuffixBlock(fileLines: string[], endLine: number, replacement: string[]): number {
	const max = Math.min(replacement.length, fileLines.length - endLine);
	for (let count = max; count >= 2; count--) {
		let matches = true;
		for (let offset = 0; offset < count; offset++) {
			if (fileLines[endLine + offset] !== replacement[replacement.length - count + offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return count;
	}
	return 0;
}

// Single-line duplicate absorption is limited to structural closing delimiters.
// General one-line context is too easy to delete incorrectly, but duplicated
// `};` / `)` / `]` boundaries usually indicate a replacement range stopped one
// line early and would otherwise produce a syntax error.
const STRUCTURAL_CLOSING_BOUNDARY_RE = /^\s*[\])}]+[;,]?\s*$/;

function isStructuralClosingBoundaryLine(line: string): boolean {
	return STRUCTURAL_CLOSING_BOUNDARY_RE.test(line);
}

interface DelimiterBalance {
	paren: number;
	bracket: number;
	brace: number;
}

const ZERO_DELIMITER_BALANCE: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 };

/**
 * Naive bracket counter — does NOT skip string/template/comment contents. The
 * single-line structural absorb relies on this being safe-by-asymmetry: the
 * candidate boundary line is constrained by `STRUCTURAL_CLOSING_BOUNDARY_RE`
 * to be pure delimiters, so noise in deleted lines or non-boundary kept payload
 * tends to push `expected !== kept` and biases the heuristic toward NOT
 * absorbing (the safe direction). If we ever extend this to opening boundaries
 * or non-structural single lines, swap this for a real tokenizer.
 */
function computeDelimiterBalance(lines: string[]): DelimiterBalance {
	const balance: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 };
	for (const line of lines) {
		for (const char of line) {
			switch (char) {
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
	}
	return balance;
}

function delimiterBalancesEqual(a: DelimiterBalance, b: DelimiterBalance): boolean {
	return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace;
}

/**
 * Decides whether the structural-boundary candidate should be dropped: the
 * `keptPayload` (full payload with the boundary line removed) must restore the
 * caller's `expectedBalance`, while the `fullPayload` (boundary line still
 * present) must NOT. For replacements `expectedBalance` is the deleted
 * region's net delimiter balance; for pure inserts it is zero.
 */
function shouldDropSingleStructuralBoundary(
	fullPayload: string[],
	keptPayload: string[],
	expectedBalance: DelimiterBalance,
): boolean {
	return (
		delimiterBalancesEqual(computeDelimiterBalance(keptPayload), expectedBalance) &&
		!delimiterBalancesEqual(computeDelimiterBalance(fullPayload), expectedBalance)
	);
}

function countMatchingSingleStructuralPrefixBoundary(
	fileLines: string[],
	startLine: number,
	replacement: string[],
	expectedBalance: DelimiterBalance,
): number {
	if (replacement.length === 0 || startLine <= 1) return 0;
	const line = replacement[0];
	if (!isStructuralClosingBoundaryLine(line)) return 0;
	if (fileLines[startLine - 2] !== line) return 0;
	return shouldDropSingleStructuralBoundary(replacement, replacement.slice(1), expectedBalance) ? 1 : 0;
}

function countMatchingSingleStructuralSuffixBoundary(
	fileLines: string[],
	endLine: number,
	replacement: string[],
	expectedBalance: DelimiterBalance,
): number {
	if (replacement.length === 0 || endLine >= fileLines.length) return 0;
	const line = replacement[replacement.length - 1];
	if (!isStructuralClosingBoundaryLine(line)) return 0;
	if (fileLines[endLine] !== line) return 0;
	return shouldDropSingleStructuralBoundary(replacement, replacement.slice(0, -1), expectedBalance) ? 1 : 0;
}

function hasExternalTargets(lines: Iterable<number>, externalTargetLines: Set<number>): boolean {
	for (const line of lines) {
		if (externalTargetLines.has(line)) return true;
	}
	return false;
}

function contiguousRange(start: number, count: number): number[] {
	return Array.from({ length: count }, (_, offset) => start + offset);
}

function deleteEditForAutoAbsorbedLine(
	line: number,
	sourceLineNum: number,
	index: number,
	fileLines: string[],
): HashlineEdit {
	return {
		kind: "delete",
		anchor: { line, hash: computeLineHash(line, fileLines[line - 1] ?? "") },
		lineNum: sourceLineNum,
		index,
	};
}

interface HashlinePureInsertGroup {
	startIndex: number;
	endIndex: number;
	sourceLineNum: number;
	cursor: HashlineCursor;
	payload: string[];
}

function cursorMatches(a: HashlineCursor, b: HashlineCursor): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "bof" || a.kind === "eof") return true;
	const aAnchor = (a as { anchor: Anchor }).anchor;
	const bAnchor = (b as { anchor: Anchor }).anchor;
	return aAnchor.line === bAnchor.line && aAnchor.hash === bAnchor.hash;
}

/**
 * Collects a run of consecutive `insert` edits that all share the same
 * `lineNum` and `cursor`, IFF that run is not immediately followed by a
 * `delete` at the same `lineNum` (which would make it a replacement group
 * instead). Returns the contiguous payload so we can check it for boundary
 * duplicates against the file.
 */
function findPureInsertGroup(edits: HashlineEdit[], startIndex: number): HashlinePureInsertGroup | undefined {
	const first = edits[startIndex];
	if (first?.kind !== "insert") return undefined;

	const sourceLineNum = first.lineNum;
	const cursor = first.cursor;
	const payload: string[] = [];
	let index = startIndex;
	while (index < edits.length) {
		const edit = edits[index];
		if (edit.kind !== "insert" || edit.lineNum !== sourceLineNum) break;
		if (!cursorMatches(edit.cursor, cursor)) break;
		payload.push(edit.text);
		index++;
	}

	// If the run is followed by a delete at the same source lineNum, this is a
	// replacement group (handled by absorbReplacement…). Decline.
	if (index < edits.length && edits[index].kind === "delete" && edits[index].lineNum === sourceLineNum) {
		return undefined;
	}

	return { startIndex, endIndex: index - 1, sourceLineNum, cursor, payload };
}

/**
 * For a pure-insert group, locate the file region adjacent to the insertion
 * point. Returns 0-indexed bounds:
 *   - `aboveEndIdx`: index of the last file line strictly above the insertion
 *     point (-1 if none).
 *   - `belowStartIdx`: index of the first file line strictly below the
 *     insertion point (`fileLines.length` if none).
 */
function pureInsertNeighborhood(
	cursor: HashlineCursor,
	fileLines: string[],
): { aboveEndIdx: number; belowStartIdx: number } {
	if (cursor.kind === "bof") return { aboveEndIdx: -1, belowStartIdx: 0 };
	if (cursor.kind === "eof") return { aboveEndIdx: fileLines.length - 1, belowStartIdx: fileLines.length };
	if (cursor.kind === "before_anchor") {
		return { aboveEndIdx: cursor.anchor.line - 2, belowStartIdx: cursor.anchor.line - 1 };
	}
	// after_anchor
	return { aboveEndIdx: cursor.anchor.line - 1, belowStartIdx: cursor.anchor.line };
}

interface PureInsertAbsorbResult {
	keptPayload: string[];
	absorbedLeading: number;
	absorbedTrailing: number;
	leadingFileRange?: { start: number; end: number }; // 1-indexed inclusive
	trailingFileRange?: { start: number; end: number }; // 1-indexed inclusive
}

/**
 * Mirror of replacement-absorb's prefix/suffix block check, but for pure
 * inserts: drop payload lines that exactly duplicate the file lines
 * immediately above (leading) or immediately below (trailing) the insertion
 * point. Generic context echo absorption requires a minimum run of 2, but a
 * single structural closing delimiter is absorbed because duplicated `}` /
 * `});`-style boundaries almost always mean the insert included adjacent
 * context.
 */
function tryAbsorbPureInsertGroup(
	group: HashlinePureInsertGroup,
	fileLines: string[],
	allowGenericBoundaryAbsorb: boolean,
): PureInsertAbsorbResult {
	const empty: PureInsertAbsorbResult = { keptPayload: group.payload, absorbedLeading: 0, absorbedTrailing: 0 };
	if (group.payload.length === 0) return empty;

	const { aboveEndIdx, belowStartIdx } = pureInsertNeighborhood(group.cursor, fileLines);

	// Leading: payload[0..k-1] vs fileLines[aboveEndIdx-k+1 .. aboveEndIdx].
	let absorbedLeading = 0;
	if (allowGenericBoundaryAbsorb) {
		const maxLead = Math.min(group.payload.length, aboveEndIdx + 1);
		for (let count = maxLead; count >= 2; count--) {
			let ok = true;
			for (let offset = 0; offset < count; offset++) {
				if (group.payload[offset] !== fileLines[aboveEndIdx - count + 1 + offset]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				absorbedLeading = count;
				break;
			}
		}
	}
	if (
		absorbedLeading === 0 &&
		group.payload.length > 0 &&
		aboveEndIdx >= 0 &&
		isStructuralClosingBoundaryLine(group.payload[0]) &&
		group.payload[0] === fileLines[aboveEndIdx] &&
		shouldDropSingleStructuralBoundary(group.payload, group.payload.slice(1), ZERO_DELIMITER_BALANCE)
	) {
		absorbedLeading = 1;
	}

	// Trailing: payload[len-k..len-1] vs fileLines[belowStartIdx..belowStartIdx+k-1].
	// Don't double-count payload lines already absorbed as leading.
	let absorbedTrailing = 0;
	const remainingPayload = group.payload.slice(absorbedLeading);
	const remaining = remainingPayload.length;
	if (allowGenericBoundaryAbsorb) {
		const maxTrail = Math.min(remaining, fileLines.length - belowStartIdx);
		for (let count = maxTrail; count >= 2; count--) {
			let ok = true;
			for (let offset = 0; offset < count; offset++) {
				if (group.payload[group.payload.length - count + offset] !== fileLines[belowStartIdx + offset]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				absorbedTrailing = count;
				break;
			}
		}
	}
	if (
		absorbedTrailing === 0 &&
		remaining > 0 &&
		belowStartIdx < fileLines.length &&
		isStructuralClosingBoundaryLine(remainingPayload[remainingPayload.length - 1]) &&
		remainingPayload[remainingPayload.length - 1] === fileLines[belowStartIdx] &&
		shouldDropSingleStructuralBoundary(remainingPayload, remainingPayload.slice(0, -1), ZERO_DELIMITER_BALANCE)
	) {
		absorbedTrailing = 1;
	}

	if (absorbedLeading === 0 && absorbedTrailing === 0) return empty;

	return {
		keptPayload: group.payload.slice(absorbedLeading, group.payload.length - absorbedTrailing),
		absorbedLeading,
		absorbedTrailing,
		leadingFileRange:
			absorbedLeading > 0 ? { start: aboveEndIdx - absorbedLeading + 2, end: aboveEndIdx + 1 } : undefined,
		trailingFileRange:
			absorbedTrailing > 0 ? { start: belowStartIdx + 1, end: belowStartIdx + absorbedTrailing } : undefined,
	};
}

function absorbReplacementBoundaryDuplicates(
	edits: HashlineEdit[],
	fileLines: string[],
	warnings: string[],
	options: HashlineApplyOptions,
): HashlineEdit[] {
	let nextSyntheticIndex = edits.length;
	const absorbed: HashlineEdit[] = [];

	// Anchor targets are stable across the loop because we only ever append
	// synthetic deletes (never mutate originals). A line in this set that
	// falls outside the current group's range is necessarily owned by another
	// op, so absorbing it would silently steal its target.
	const allTargetLines = collectAnchorTargetLines(edits);
	const emittedAbsorbKeys = new Set<string>();

	for (let index = 0; index < edits.length; index++) {
		const group = findReplacementGroup(edits, index);
		if (!group) {
			const pureInsert = findPureInsertGroup(edits, index);
			if (pureInsert) {
				const result = tryAbsorbPureInsertGroup(
					pureInsert,
					fileLines,
					options.autoDropPureInsertDuplicates === true,
				);
				if (result.absorbedLeading > 0 || result.absorbedTrailing > 0) {
					if (result.leadingFileRange) {
						const { start, end } = result.leadingFileRange;
						const key = `pure-insert-leading:${start}..${end}`;
						if (!emittedAbsorbKeys.has(key)) {
							emittedAbsorbKeys.add(key);
							warnings.push(
								`Auto-dropped ${result.absorbedLeading} duplicate line(s) at the start of insert at line ${pureInsert.sourceLineNum} ` +
									`(file lines ${start}..${end} already match the payload's leading lines).`,
							);
						}
					}
					if (result.trailingFileRange) {
						const { start, end } = result.trailingFileRange;
						const key = `pure-insert-trailing:${start}..${end}`;
						if (!emittedAbsorbKeys.has(key)) {
							emittedAbsorbKeys.add(key);
							warnings.push(
								`Auto-dropped ${result.absorbedTrailing} duplicate line(s) at the end of insert at line ${pureInsert.sourceLineNum} ` +
									`(file lines ${start}..${end} already match the payload's trailing lines).`,
							);
						}
					}
					for (const text of result.keptPayload) {
						absorbed.push({
							kind: "insert",
							cursor: cloneCursor(pureInsert.cursor),
							text,
							lineNum: pureInsert.sourceLineNum,
							index: nextSyntheticIndex++,
						});
					}
					index = pureInsert.endIndex;
					continue;
				}
				for (let groupIndex = pureInsert.startIndex; groupIndex <= pureInsert.endIndex; groupIndex++) {
					absorbed.push(edits[groupIndex]);
				}
				index = pureInsert.endIndex;
				continue;
			}
			absorbed.push(edits[index]);
			continue;
		}

		const startLine = group.deletes[0].anchor.line;
		const endLine = group.deletes[group.deletes.length - 1].anchor.line;

		const deletedBalance = computeDelimiterBalance(
			group.deletes.map(deleteEdit => fileLines[deleteEdit.anchor.line - 1] ?? ""),
		);
		const prefixCount =
			countMatchingPrefixBlock(fileLines, startLine, group.replacement) ||
			countMatchingSingleStructuralPrefixBoundary(fileLines, startLine, group.replacement, deletedBalance);
		const suffixCount =
			countMatchingSuffixBlock(fileLines, endLine, group.replacement) ||
			countMatchingSingleStructuralSuffixBoundary(fileLines, endLine, group.replacement, deletedBalance);
		const prefixLines = contiguousRange(startLine - prefixCount, prefixCount);
		const suffixLines = contiguousRange(endLine + 1, suffixCount);
		const safePrefixCount = hasExternalTargets(prefixLines, allTargetLines) ? 0 : prefixCount;
		const safeSuffixCount = hasExternalTargets(suffixLines, allTargetLines) ? 0 : suffixCount;

		if (safePrefixCount > 0) {
			const absorbStart = startLine - safePrefixCount;
			const key = `prefix:${absorbStart}..${startLine - 1}`;
			if (!emittedAbsorbKeys.has(key)) {
				emittedAbsorbKeys.add(key);
				warnings.push(
					`Auto-absorbed ${safePrefixCount} duplicate line(s) above replacement at line ${group.sourceLineNum} ` +
						`(file lines ${absorbStart}..${startLine - 1} matched the payload's leading lines; ` +
						`widened the deletion to absorb them).`,
				);
			}
		}
		if (safeSuffixCount > 0) {
			const absorbEnd = endLine + safeSuffixCount;
			const key = `suffix:${endLine + 1}..${absorbEnd}`;
			if (!emittedAbsorbKeys.has(key)) {
				emittedAbsorbKeys.add(key);
				warnings.push(
					`Auto-absorbed ${safeSuffixCount} duplicate line(s) below replacement at line ${group.sourceLineNum} ` +
						`(file lines ${endLine + 1}..${absorbEnd} matched the payload's trailing lines; ` +
						`widened the deletion to absorb them).`,
				);
			}
		}

		for (const line of contiguousRange(startLine - safePrefixCount, safePrefixCount)) {
			absorbed.push(deleteEditForAutoAbsorbedLine(line, group.sourceLineNum, nextSyntheticIndex++, fileLines));
		}
		for (let groupIndex = group.startIndex; groupIndex <= group.endIndex; groupIndex++) {
			absorbed.push(edits[groupIndex]);
		}
		for (const line of contiguousRange(endLine + 1, safeSuffixCount)) {
			absorbed.push(deleteEditForAutoAbsorbedLine(line, group.sourceLineNum, nextSyntheticIndex++, fileLines));
		}

		index = group.endIndex;
	}

	return absorbed;
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

export function applyHashlineEdits(
	text: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions = {},
): HashlineApplyResult {
	if (edits.length === 0) return { lines: text, firstChangedLine: undefined };

	const fileLines = text.split("\n");
	const lineOrigins: HashlineLineOrigin[] = fileLines.map(() => "original");
	const warnings: string[] = [];

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const mismatches = validateHashlineAnchors(edits, fileLines);
	if (mismatches.length > 0) throw new HashlineMismatchError(mismatches, fileLines);

	const normalizedEdits = absorbReplacementBoundaryDuplicates(edits, fileLines, warnings, options);

	// Normalize after_anchor inserts to before_anchor of the next line, or EOF
	// when the anchor is the final line. This keeps the bucketing logic below
	// (which only knows about before_anchor / bof / eof) untouched.
	for (const edit of normalizedEdits) {
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
	normalizedEdits.forEach((edit, idx) => {
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
			if (edit.kind === "insert") {
				beforeLines.push(edit.text);
			} else if (edit.kind === "delete") {
				deleteLine = true;
			}
		}
		if (beforeLines.length === 0 && !deleteLine) continue;

		const replacement = deleteLine ? beforeLines : [...beforeLines, currentLine];
		const origins = replacement.map((): HashlineLineOrigin => (deleteLine ? "replacement" : "insert"));
		if (!deleteLine) {
			origins[origins.length - 1] = lineOrigins[idx] ?? "original";
		}

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
