/**
 * Atom edit mode.
 *
 * Single-string compact wire format. Each file section starts with `---path`;
 * each following line is one statement:
 *
 *   @Lid                    move cursor to just after the anchored line
 *   Lid=TEXT                set the anchored line to TEXT and move cursor after it
 *   -Lid                    delete the anchored line and move cursor to its slot
 *   +TEXT                   insert TEXT at the cursor
 *   $                       move cursor to beginning of file
 *   ^                       move cursor to end of file
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { assertEditableFile, assertEditableFileContent } from "../../tools/auto-generated-guard";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateDiffString } from "../diff";
import { computeLineHash } from "../line-hash";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import {
	ANCHOR_REBASE_WINDOW,
	type Anchor,
	buildCompactHashlineDiffPreview,
	HashlineMismatchError,
	type HashMismatch,
	tryRebaseAnchor,
} from "./hashline";

// ═══════════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════════

export const atomEditParamsSchema = Type.Object({ input: Type.String() });

export type AtomParams = Static<typeof atomEditParamsSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

// Permissive: any 2 lowercase letters. Invalid hashes flow through to a
// HashlineMismatchError downstream, matching the other hashline-backed modes.
const LID_RE = /^([1-9]\d*)([a-z]{2})/;
const LID_EXACT_RE = /^([1-9]\d*)([a-z]{2})$/;

interface ParsedAnchor {
	line: number;
	hash: string;
}

type ParsedOp = { op: "set"; text: string; allowOldNewRepair: boolean } | { op: "delete" };

type AnchorStmt =
	| { kind: "bare_anchor"; anchor: ParsedAnchor; lineNum: number }
	| { kind: "anchor_op"; anchor: ParsedAnchor; op: ParsedOp; lineNum: number }
	| { kind: "bof"; lineNum: number }
	| { kind: "eof"; lineNum: number };

type InsertStmt = {
	kind: "insert";
	text: string;
	lineNum: number;
};

type DiffishAddStmt = {
	kind: "diffish_add";
	anchor: ParsedAnchor;
	text: string;
	lineNum: number;
};

type DeleteWithOldStmt = {
	kind: "delete_with_old";
	anchor: ParsedAnchor;
	old: string;
	lineNum: number;
};

type ParsedStmt = AnchorStmt | InsertStmt | DiffishAddStmt | DeleteWithOldStmt;

type AtomCursor = { kind: "bof" } | { kind: "eof" } | { kind: "anchor"; anchor: Anchor };

export type AtomEdit =
	| { kind: "insert"; cursor: AtomCursor; text: string; lineNum: number; index: number }
	| { kind: "set"; anchor: Anchor; text: string; lineNum: number; index: number; allowOldNewRepair: boolean }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string };

interface AtomApplyResult {
	lines: string;
	firstChangedLine?: number;
	warnings?: string[];
	noopEdits?: AtomNoopEdit[];
}

interface AtomNoopEdit {
	editIndex: number;
	loc: string;
	reason: string;
	current: string;
}

interface IndexedAnchorEdit {
	edit: Extract<AtomEdit, { kind: "insert" | "set" | "delete" }>;
	idx: number;
}

function cloneCursor(cursor: AtomCursor): AtomCursor {
	if (cursor.kind !== "anchor") return cursor;
	return { kind: "anchor", anchor: { ...cursor.anchor } };
}

function parseLidStmt(body: string, lineNum: number): AnchorStmt | null {
	const m = LID_RE.exec(body);
	if (!m) return null;

	const ln = Number.parseInt(m[1], 10);
	const hash = m[2];
	const rest = body.slice(m[0].length);
	const anchor = { line: ln, hash };
	if (rest.length === 0) {
		return { kind: "bare_anchor", anchor, lineNum };
	}

	const replacement = /^[ \t]*([=|])(.*)$/.exec(rest);
	if (!replacement) return null;
	return {
		kind: "anchor_op",
		anchor,
		op: { op: "set", text: replacement[2], allowOldNewRepair: replacement[1] === "|" },
		lineNum,
	};
}

function parseDeleteStmt(body: string, lineNum: number): ParsedStmt[] | null {
	const trimmedBody = body.trimStart();
	const exact = LID_EXACT_RE.exec(trimmedBody);
	if (exact) {
		const ln = Number.parseInt(exact[1], 10);
		return [{ kind: "anchor_op", anchor: { line: ln, hash: exact[2] }, op: { op: "delete" }, lineNum }];
	}

	const m = LID_RE.exec(trimmedBody);
	if (m && (trimmedBody[m[0].length] === "|" || trimmedBody[m[0].length] === "=")) {
		const ln = Number.parseInt(m[1], 10);
		const old = trimmedBody.slice(m[0].length + 1);
		return [{ kind: "delete_with_old", anchor: { line: ln, hash: m[2] }, old, lineNum }];
	}
	if (m && trimmedBody[m[0].length] === " ") {
		const ln = Number.parseInt(m[1], 10);
		const text = trimmedBody.slice(m[0].length + 1);
		return [
			{ kind: "anchor_op", anchor: { line: ln, hash: m[2] }, op: { op: "delete" }, lineNum },
			{ kind: "insert", text, lineNum },
		];
	}

	return null;
}

function throwMalformedLidDiagnostic(line: string, lineNum: number, raw: string): never {
	const text = line.trimStart();
	const withoutLegacyMove = text.startsWith("@@ ") ? text.slice(3).trimStart() : text;
	const withoutMove = withoutLegacyMove.startsWith("@") ? withoutLegacyMove.slice(1) : withoutLegacyMove;
	const withoutDelete = withoutMove.startsWith("-") ? withoutMove.slice(1).trimStart() : withoutMove;

	const partial = /^([a-z]{2})(?=[ \t]*[=|])/.exec(withoutDelete);
	if (partial) {
		throw new Error(
			`Diff line ${lineNum}: \`${partial[1]}\` is not a full Lid. Use the full Lid from read output, e.g. \`119${partial[1]}\`.`,
		);
	}

	const missing = /^([1-9]\d*)(?=[ \t]*[=|]|$)/.exec(withoutDelete);
	if (missing) {
		const prefix = text.startsWith("@@ ") ? `@@ ${missing[1]}` : missing[1];
		throw new Error(
			`Diff line ${lineNum}: \`${prefix}\` is missing the two-letter Lid suffix. Use the full Lid from read output, e.g. \`${prefix.startsWith("@@ ") ? "@@ " : ""}${missing[1]}ab\`.`,
		);
	}

	throw new Error(`Diff line ${lineNum}: cannot parse "${raw}".`);
}

function parseDiffLine(raw: string, lineNum: number): ParsedStmt[] {
	// Strip trailing CR (CRLF tolerance).
	const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
	if (line.length === 0) return [];

	// `+TEXT` inserts at the cursor. Everything after `+` is content. A
	// `+Lid|TEXT` or `+Lid=TEXT` line is a diff-ish add (unified-diff trap):
	// emit a tagged stmt so the normalizer can fuse it with a preceding `-Lid`.
	if (line[0] === "+") {
		const body = line.slice(1);
		const m = LID_RE.exec(body);
		if (m) {
			const sep = body[m[0].length];
			if (sep === "=" || sep === "|") {
				const ln = Number.parseInt(m[1], 10);
				const text = body.slice(m[0].length + 1);
				return [{ kind: "diffish_add", anchor: { line: ln, hash: m[2] }, text, lineNum }];
			}
		}
		return [{ kind: "insert", text: body, lineNum }];
	}

	// Canonical file-scope locators.
	if (line === "$") return [{ kind: "bof", lineNum }];
	if (line === "^") return [{ kind: "eof", lineNum }];

	// `-Lid` deletes the anchored line. Leniently accept `- Lid` and the
	// historical `-Lid TEXT` delete-then-insert recovery.
	if (line[0] === "-") {
		const parsed = parseDeleteStmt(line.slice(1), lineNum);
		if (parsed) return parsed;
		// Lenient: a stray `-` line with no Lid becomes a `+` insert that
		// preserves the leading dash so we don't lose data.
		return [{ kind: "insert", text: line, lineNum }];
	}

	// Legacy move prefix. Runtime accepts old locators and common slipped edit
	// operations, while the grammar/prompt bias models to canonical syntax.
	if (line.startsWith("@@ ")) {
		const body = line.slice(3);
		if (body === "BOF") return [{ kind: "bof", lineNum }];
		if (body === "EOF") return [{ kind: "eof", lineNum }];

		const deleteStmt = body.startsWith("-") ? parseDeleteStmt(body.slice(1), lineNum) : null;
		if (deleteStmt) return deleteStmt;

		const lidStmt = parseLidStmt(body, lineNum);
		if (lidStmt) return [lidStmt];

		throwMalformedLidDiagnostic(line, lineNum, raw);
	}

	// Canonical `@Lid` cursor moves. Leniently recover `@Lid=TEXT`,
	// `@Lid|TEXT`, `@$`, and `@^`.
	if (line[0] === "@") {
		const body = line.slice(1);
		if (body === "$") return [{ kind: "bof", lineNum }];
		if (body === "^") return [{ kind: "eof", lineNum }];
		const lidStmt = parseLidStmt(body, lineNum);
		if (lidStmt) return [lidStmt];
		throwMalformedLidDiagnostic(line, lineNum, raw);
	}

	// `Lid=TEXT` sets the anchored line. Legacy `Lid|TEXT` remains accepted.
	// A bare `Lid` is a cursor move.
	const lidStmt = parseLidStmt(line, lineNum);
	if (lidStmt) return [lidStmt];

	if (/^[a-z]{2}(?=[ \t]*[=|])/.test(line) || /^[1-9]\d*(?=[ \t]*[=|]|$)/.test(line)) {
		throwMalformedLidDiagnostic(line, lineNum, raw);
	}

	// Lenient catch-all: lines that don't match any recognized prefix become
	// inserts at the cursor.
	return [{ kind: "insert", text: line, lineNum }];
}

function tokenizeDiff(diff: string): ParsedStmt[] {
	const out: ParsedStmt[] = [];
	const lines = diff.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stmts = parseDiffLine(lines[i], lineNum);
		for (const stmt of stmts) {
			// Last-set-wins: when the same anchor (line+hash) gets a second `set`,
			// drop the earlier one. Models sometimes echo the OLD line and then the
			// NEW line as replacements (e.g. `119yh|OLD` / `119yh|NEW`); the last is
			// the intended value.
			if (stmt.kind === "anchor_op" && stmt.op.op === "set") {
				const key = `${stmt.anchor.line}:${stmt.anchor.hash}`;
				for (let j = out.length - 1; j >= 0; j--) {
					const prior = out[j];
					if (
						prior.kind === "anchor_op" &&
						prior.op.op === "set" &&
						`${prior.anchor.line}:${prior.anchor.hash}` === key
					) {
						out.splice(j, 1);
						break;
					}
				}
			}
			out.push(stmt);
		}
	}
	return normalizeHunks(out);
}

// Detect contiguous `[delete | delete_with_old]+ [insert | diffish_add]+`
// hunks and reorder so adds land at the FIRST delete's slot (block
// replacement). Single-line `-Lid` + `+Lid|TEXT` (same Lid) fuses to a
// `set`. Standalone `+Lid|TEXT` and `+Lid|TEXT` referencing a Lid not in
function normalizeHunks(stmts: ParsedStmt[]): ParsedStmt[] {
	const isDelete = (s: ParsedStmt): boolean =>
		(s.kind === "anchor_op" && s.op.op === "delete") || s.kind === "delete_with_old";
	const isAdd = (s: ParsedStmt): boolean => s.kind === "insert" || s.kind === "diffish_add";
	const out: ParsedStmt[] = [];
	let i = 0;
	while (i < stmts.length) {
		const stmt = stmts[i];
		if (!isDelete(stmt)) {
			if (stmt.kind === "diffish_add") {
				const lid = `${stmt.anchor.line}${stmt.anchor.hash}`;
				throw new Error(
					`Diff line ${stmt.lineNum}: \`+${lid}|...\` looks like a unified-diff replacement marker. Use \`${lid}=TEXT\` to replace, or precede with \`-${lid}\` to delete-then-replace.`,
				);
			}
			out.push(stmt);
			i++;
			continue;
		}
		const deletes: ParsedStmt[] = [];
		while (i < stmts.length && isDelete(stmts[i])) {
			deletes.push(stmts[i]);
			i++;
		}
		const adds: ParsedStmt[] = [];
		while (i < stmts.length && isAdd(stmts[i])) {
			adds.push(stmts[i]);
			i++;
		}
		const deletedLids = new Set(
			deletes.map(d => {
				const a = (d as { anchor: ParsedAnchor }).anchor;
				return `${a.line}${a.hash}`;
			}),
		);
		for (const add of adds) {
			if (add.kind !== "diffish_add") continue;
			const lid = `${add.anchor.line}${add.anchor.hash}`;
			if (!deletedLids.has(lid)) {
				throw new Error(
					`Diff line ${add.lineNum}: \`+${lid}|...\` references a Lid that was not deleted in the preceding run. Use \`${lid}=TEXT\` to replace, or precede with \`-${lid}\`.`,
				);
			}
		}
		// Single-line case: 1 delete (with or without OLD) + 1 diffish_add same Lid → fuse to set.
		if (deletes.length === 1 && adds.length === 1 && adds[0].kind === "diffish_add") {
			const dAnchor = (deletes[0] as { anchor: ParsedAnchor }).anchor;
			const a = adds[0];
			if (a.anchor.line === dAnchor.line && a.anchor.hash === dAnchor.hash) {
				out.push({
					kind: "anchor_op",
					anchor: a.anchor,
					op: { op: "set", text: a.text, allowOldNewRepair: false },
					lineNum: a.lineNum,
				});
				continue;
			}
		}
		// Block: emit delete[0], then all inserts (which land at delete[0]'s slot
		// because the cursor binds to delete[0] before the inserts), then the
		// remaining deletes.
		out.push(deletes[0]);
		for (const add of adds) {
			const text = add.kind === "insert" ? add.text : (add as DiffishAddStmt).text;
			out.push({ kind: "insert", text, lineNum: add.lineNum });
		}
		for (let j = 1; j < deletes.length; j++) {
			out.push(deletes[j]);
		}
	}
	return out;
}

function makeAnchor(anchor: ParsedAnchor): Anchor {
	return { line: anchor.line, hash: anchor.hash };
}

// ═══════════════════════════════════════════════════════════════════════════
// Build cursor-program from ParsedStmt[]
// ═══════════════════════════════════════════════════════════════════════════

export function parseAtom(diff: string): AtomEdit[] {
	const edits: AtomEdit[] = [];
	let cursor: AtomCursor = { kind: "eof" };
	let index = 0;

	for (const stmt of tokenizeDiff(diff)) {
		if (stmt.kind === "insert") {
			edits.push({ kind: "insert", cursor: cloneCursor(cursor), text: stmt.text, lineNum: stmt.lineNum, index });
			index++;
			continue;
		}

		if (stmt.kind === "bof") {
			cursor = { kind: "bof" };
			continue;
		}
		if (stmt.kind === "eof") {
			cursor = { kind: "eof" };
			continue;
		}

		if (stmt.kind === "delete_with_old") {
			const anchor = makeAnchor(stmt.anchor);
			cursor = { kind: "anchor", anchor: { ...anchor } };
			edits.push({ kind: "delete", anchor, lineNum: stmt.lineNum, index, oldAssertion: stmt.old });
			index++;
			continue;
		}

		if (stmt.kind === "diffish_add") {
			throw new Error("Internal atom error: unresolved diff-ish add reached parseAtom.");
		}

		const anchor = makeAnchor(stmt.anchor);
		cursor = { kind: "anchor", anchor: { ...anchor } };
		if (stmt.kind === "bare_anchor") continue;

		if (stmt.op.op === "set") {
			if (stmt.op.text.includes("\r")) {
				throw new Error(
					`Diff line ${stmt.lineNum}: set value contains a carriage return; use a single-line value.`,
				);
			}
			edits.push({
				kind: "set",
				anchor,
				text: stmt.op.text,
				lineNum: stmt.lineNum,
				index,
				allowOldNewRepair: stmt.op.allowOldNewRepair,
			});
			index++;
			continue;
		}

		edits.push({ kind: "delete", anchor, lineNum: stmt.lineNum, index });
		index++;
	}

	return edits;
}

function formatNoAtomEditDiagnostic(_path: string, diff: string): string {
	const body = diff
		.split("\n")
		.map(line => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.filter(line => line.trim().length > 0)
		.slice(0, 3)
		.map(line => `  ${line}`)
		.join("\n");
	const preview = body.length > 0 ? `\nReceived only locator/context lines:\n${body}` : "";
	return `Cursor moved but no mutation found. Add +TEXT to insert, -Lid to delete, or Lid=TEXT to replace.${preview}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Apply cursor-program
// ═══════════════════════════════════════════════════════════════════════════

function getAtomEditAnchors(edit: AtomEdit): Anchor[] {
	if (edit.kind === "set" || edit.kind === "delete") return [edit.anchor];
	if (edit.cursor.kind === "anchor") return [edit.cursor.anchor];
	return [];
}

function validateAtomAnchors(edits: AtomEdit[], fileLines: string[], warnings: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	const rebasedAnchors = new Map<Anchor, HashMismatch>();
	for (const edit of edits) {
		for (const anchor of getAtomEditAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
			const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]);
			if (actualHash === anchor.hash) continue;

			const rebased = tryRebaseAnchor(anchor, fileLines);
			if (rebased !== null) {
				const original = `${anchor.line}${anchor.hash}`;
				rebasedAnchors.set(anchor, { line: anchor.line, expected: anchor.hash, actual: actualHash });
				anchor.line = rebased;
				warnings.push(
					`Auto-rebased anchor ${original} → ${rebased}${anchor.hash} (line shifted within ±${ANCHOR_REBASE_WINDOW}; hash matched).`,
				);
				continue;
			}
			mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
		}
	}

	// Detect post-rebase conflicts. If any conflicting anchor was rebased, surface
	// the original hash mismatch instead — the rebase itself is what created the
	// conflict, and the model needs to fix the stale anchor, not deduplicate.
	const seenLines = new Map<number, Anchor>();
	for (const edit of edits) {
		if (edit.kind !== "set" && edit.kind !== "delete") continue;
		const existing = seenLines.get(edit.anchor.line);
		if (existing) {
			const rebasedA = rebasedAnchors.get(edit.anchor);
			const rebasedB = rebasedAnchors.get(existing);
			if (rebasedA) mismatches.push(rebasedA);
			else if (rebasedB) mismatches.push(rebasedB);
			continue;
		}
		seenLines.set(edit.anchor.line, edit.anchor);
	}
	return mismatches;
}

function validateNoConflictingAtomMutations(edits: AtomEdit[]): void {
	const mutatingPerLine = new Map<number, string>();
	for (const edit of edits) {
		if (edit.kind !== "set" && edit.kind !== "delete") continue;
		const existing = mutatingPerLine.get(edit.anchor.line);
		if (existing) {
			throw new Error(
				`Conflicting ops on anchor line ${edit.anchor.line}: \`${existing}\` and \`${edit.kind}\`. ` +
					"At most one mutating op (set/delete) is allowed per anchor.",
			);
		}
		mutatingPerLine.set(edit.anchor.line, edit.kind);
	}
}

function repairAtomOldNewSetLine(currentLine: string, nextLine: string): string {
	const marker = `${currentLine}|`;
	if (!nextLine.startsWith(marker)) return nextLine;
	const repaired = nextLine.slice(marker.length);
	return repaired.length > 0 ? repaired : nextLine;
}

function insertAtStart(fileLines: string[], lines: string[]): void {
	if (lines.length === 0) return;
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		return;
	}
	fileLines.splice(0, 0, ...lines);
}

function insertAtEnd(fileLines: string[], lines: string[]): number | undefined {
	if (lines.length === 0) return undefined;
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		return 1;
	}
	const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
	const insertIdx = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
	fileLines.splice(insertIdx, 0, ...lines);
	return insertIdx + 1;
}

function isSameFileCursor(a: AtomCursor, b: AtomCursor): boolean {
	return a.kind === b.kind && a.kind !== "anchor";
}

function collectFileInsertRuns(
	fileInserts: Extract<AtomEdit, { kind: "insert" }>[],
): Array<{ cursor: AtomCursor; lines: string[] }> {
	const runs: Array<{ cursor: AtomCursor; lines: string[] }> = [];
	for (const edit of fileInserts.sort((a, b) => a.index - b.index)) {
		const prev = runs[runs.length - 1];
		if (prev && isSameFileCursor(prev.cursor, edit.cursor)) {
			prev.lines.push(edit.text);
			continue;
		}
		runs.push({ cursor: edit.cursor, lines: [edit.text] });
	}
	return runs;
}
function applyFileCursorInserts(
	fileLines: string[],
	fileInserts: Extract<AtomEdit, { kind: "insert" }>[],
): number | undefined {
	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	for (const run of collectFileInsertRuns(fileInserts)) {
		if (run.cursor.kind === "bof") {
			insertAtStart(fileLines, run.lines);
			trackFirstChanged(1);
			continue;
		}
		if (run.cursor.kind === "eof") {
			const changedLine = insertAtEnd(fileLines, run.lines);
			if (changedLine !== undefined) trackFirstChanged(changedLine);
		}
	}

	return firstChangedLine;
}

function getAnchorForAnchorEdit(edit: IndexedAnchorEdit["edit"]): Anchor {
	if (edit.kind !== "insert") return edit.anchor;
	if (edit.cursor.kind !== "anchor") {
		throw new Error("Internal atom error: file-scoped insert reached anchor application.");
	}
	return edit.cursor.anchor;
}

export function applyAtomEdits(text: string, edits: AtomEdit[]): AtomApplyResult {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const warnings: string[] = [];
	let firstChangedLine: number | undefined;
	const noopEdits: AtomNoopEdit[] = [];

	const mismatches = validateAtomAnchors(edits, fileLines, warnings);
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}
	validateNoConflictingAtomMutations(edits);

	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const anchorEdits: IndexedAnchorEdit[] = [];
	const fileInserts: Extract<AtomEdit, { kind: "insert" }>[] = [];
	edits.forEach((edit, idx) => {
		if (edit.kind === "insert" && edit.cursor.kind !== "anchor") {
			fileInserts.push(edit);
			return;
		}
		anchorEdits.push({ edit, idx });
	});

	const byLine = new Map<number, IndexedAnchorEdit[]>();
	for (const entry of anchorEdits) {
		const line = getAnchorForAnchorEdit(entry.edit).line;
		const bucket = byLine.get(line);
		if (bucket) {
			bucket.push(entry);
		} else {
			byLine.set(line, [entry]);
		}
	}

	const anchorLines = [...byLine.keys()].sort((a, b) => b - a);
	for (const line of anchorLines) {
		const bucket = byLine.get(line);
		if (!bucket) continue;
		bucket.sort((a, b) => a.idx - b.idx);

		const idx = line - 1;
		const currentLine = fileLines[idx];
		let replacement: string[] = [currentLine];
		let replacementSet = false;
		let anchorMutated = false;
		const afterLines: string[] = [];

		for (const { edit } of bucket) {
			switch (edit.kind) {
				case "insert":
					afterLines.push(edit.text);
					break;
				case "set":
					replacement = [edit.allowOldNewRepair ? repairAtomOldNewSetLine(currentLine, edit.text) : edit.text];
					replacementSet = true;
					anchorMutated = true;
					break;
				case "delete":
					if (edit.oldAssertion !== undefined && edit.oldAssertion !== currentLine) {
						throw new Error(
							`Diff line ${edit.lineNum}: \`-${edit.anchor.line}${edit.anchor.hash}\` asserts the deleted line is ${JSON.stringify(edit.oldAssertion)}, but the file has ${JSON.stringify(currentLine)}. Re-anchor and retry.`,
						);
					}
					replacement = [];
					replacementSet = true;
					anchorMutated = true;
					break;
			}
		}

		const replacementProducesNoChange =
			afterLines.length === 0 && replacement.length === 1 && replacement[0] === currentLine;
		if (replacementProducesNoChange) {
			const firstEdit = bucket[0]?.edit;
			const anchor = firstEdit ? getAnchorForAnchorEdit(firstEdit) : undefined;
			noopEdits.push({
				editIndex: bucket[0]?.idx ?? 0,
				loc: anchor ? `${anchor.line}${anchor.hash}` : `${line}`,
				reason:
					firstEdit?.kind === "set"
						? "replacement is identical to the current line content; use `Lid=NEW_TEXT` and do not copy an unchanged read line"
						: "replacement is identical to the current line content",
				current: currentLine,
			});
			continue;
		}

		const combined = [...replacement, ...afterLines];
		fileLines.splice(idx, 1, ...combined);
		if (anchorMutated) {
			trackFirstChanged(line);
		} else if (afterLines.length > 0) {
			trackFirstChanged(line + 1);
		}
		if (!replacementSet && afterLines.length === 0) continue;
	}

	const fileFirstChangedLine = applyFileCursorInserts(fileLines, fileInserts);
	if (fileFirstChangedLine !== undefined) trackFirstChanged(fileFirstChangedLine);

	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
		...(noopEdits.length > 0 && firstChangedLine === undefined ? { noopEdits } : {}),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Wire-format split: extract `---` headers from the input string.
// ═══════════════════════════════════════════════════════════════════════════

const FILE_HEADER_PREFIX = "---";
const REMOVE_FILE_OPERATION = "!rm";
const MOVE_FILE_OPERATION = "!mv";

type AtomWholeFileOperation =
	| { kind: "delete"; lineNum: number }
	| { kind: "move"; destination: string; lineNum: number };

interface AtomInputSection {
	path: string;
	diff: string;
	wholeFileOperation?: AtomWholeFileOperation;
}

export interface SplitAtomOptions {
	cwd?: string;
	path?: string;
}

function isBlankHeaderPreamble(line: string): boolean {
	return line.replace(/\r$/, "").trim().length === 0;
}

function unquoteAtomPath(pathText: string): string {
	if (pathText.length < 2) return pathText;
	const first = pathText[0];
	const last = pathText[pathText.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return pathText.slice(1, -1);
	}
	return pathText;
}

function normalizeAtomPath(rawPath: string, cwd?: string): string {
	const unquoted = unquoteAtomPath(rawPath.trim());
	if (!cwd || !path.isAbsolute(unquoted)) return unquoted;

	const relative = path.relative(path.resolve(cwd), path.resolve(unquoted));
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	return isWithinCwd ? relative || "." : unquoted;
}

function parseAtomHeaderLine(line: string, cwd?: string): string | null {
	if (!line.startsWith(FILE_HEADER_PREFIX)) return null;
	let body = line.slice(FILE_HEADER_PREFIX.length);
	if (body.startsWith(" ")) body = body.slice(1);
	const parsedPath = normalizeAtomPath(body, cwd);
	if (parsedPath.length === 0) {
		throw new Error(`atom input header "${FILE_HEADER_PREFIX}" is empty; provide a file path.`);
	}
	return parsedPath;
}

function parseSingleAtomPathArgument(rawPath: string, directive: string, lineNum: number, cwd?: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		throw new Error(`Atom line ${lineNum}: ${directive} requires exactly one non-empty destination path.`);
	}

	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) {
			throw new Error(`Atom line ${lineNum}: ${directive} requires exactly one destination path.`);
		}
	} else if (/\s/.test(trimmed)) {
		throw new Error(`Atom line ${lineNum}: ${directive} requires exactly one destination path.`);
	}

	const destination = normalizeAtomPath(trimmed, cwd);
	if (destination.length === 0) {
		throw new Error(`Atom line ${lineNum}: ${directive} requires exactly one non-empty destination path.`);
	}
	return destination;
}

function parseAtomWholeFileOperationLine(
	rawLine: string,
	lineNum: number,
	cwd?: string,
): AtomWholeFileOperation | null {
	const line = rawLine.replace(/\r$/, "").trimEnd();
	if (line === REMOVE_FILE_OPERATION) {
		return { kind: "delete", lineNum };
	}
	if (line.startsWith(`${REMOVE_FILE_OPERATION} `) || line.startsWith(`${REMOVE_FILE_OPERATION}\t`)) {
		throw new Error(`Atom line ${lineNum}: ${REMOVE_FILE_OPERATION} does not take a destination path.`);
	}

	if (line === MOVE_FILE_OPERATION) {
		throw new Error(`Atom line ${lineNum}: ${MOVE_FILE_OPERATION} requires exactly one non-empty destination path.`);
	}
	if (line.startsWith(`${MOVE_FILE_OPERATION} `) || line.startsWith(`${MOVE_FILE_OPERATION}\t`)) {
		const rawDestination = line.slice(MOVE_FILE_OPERATION.length);
		return {
			kind: "move",
			destination: parseSingleAtomPathArgument(rawDestination, MOVE_FILE_OPERATION, lineNum, cwd),
			lineNum,
		};
	}

	return null;
}

function getAtomWholeFileOperation(
	sectionPath: string,
	lines: string[],
	cwd?: string,
): AtomWholeFileOperation | undefined {
	let operation: AtomWholeFileOperation | undefined;
	let operationToken = "";
	let hasLineEdit = false;

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const line = lines[i].replace(/\r$/, "");
		if (line.trim().length === 0) continue;

		const parsed = parseAtomWholeFileOperationLine(line, lineNum, cwd);
		if (parsed) {
			if (operation) {
				throw new Error(
					`Atom section ${sectionPath}: use only one ${REMOVE_FILE_OPERATION} or ${MOVE_FILE_OPERATION} operation.`,
				);
			}
			operation = parsed;
			operationToken = parsed.kind === "delete" ? REMOVE_FILE_OPERATION : MOVE_FILE_OPERATION;
			continue;
		}

		hasLineEdit = true;
	}

	if (operation && hasLineEdit) {
		throw new Error(
			`Atom section ${sectionPath} mixes ${operationToken} with line edits; ${REMOVE_FILE_OPERATION} and ${MOVE_FILE_OPERATION} must be the only operation in their section.`,
		);
	}

	return operation;
}

function hasAtomHeaderLine(input: string): boolean {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	return stripped.split("\n").some(rawLine => rawLine.replace(/\r$/, "").startsWith(FILE_HEADER_PREFIX));
}

function containsRecognizableAtomOperations(input: string): boolean {
	for (const rawLine of input.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.length === 0) continue;
		if (line[0] === "+") return true;
		if (line === "$" || line === "^") return true;
		if (/^- ?[1-9]\d*[a-z]{2}(?: .*)?$/.test(line)) return true;
		if (/^@?[1-9]\d*[a-z]{2}(?:[ \t]*[=|].*)?$/.test(line)) return true;
		if (/^@@ (?:BOF|EOF|(?:- ?)?[1-9]\d*[a-z]{2}(?:[ \t]*[=|].*)?)$/.test(line)) return true;
	}
	return false;
}

function stripLeadingBlankLines(input: string): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const lines = stripped.split("\n");
	while (lines.length > 0 && isBlankHeaderPreamble(lines[0] ?? "")) {
		lines.shift();
	}
	return lines.join("\n");
}

function normalizeFallbackInput(input: string, options: SplitAtomOptions): string {
	if (hasAtomHeaderLine(input) || !options.path || !containsRecognizableAtomOperations(input)) {
		return input;
	}
	const fallbackPath = normalizeAtomPath(options.path, options.cwd);
	if (fallbackPath.length === 0) return input;
	return `${FILE_HEADER_PREFIX}${fallbackPath}\n${input}`;
}

function getTextContent(result: AgentToolResult<EditToolDetails>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function getEditDetails(result: AgentToolResult<EditToolDetails>): EditToolDetails {
	if (result.details === undefined) {
		return { diff: "" };
	}
	return result.details;
}

/**
 * Split the wire-format `input` string into `{ path, diff }`. The first
 * non-empty line MUST be `---<path>` or `--- <path>`. Tolerates a leading BOM.
 */
export function splitAtomInput(input: string, options: SplitAtomOptions = {}): { path: string; diff: string } {
	const [section] = splitAtomInputs(input, options);
	return section;
}

export function splitAtomInputs(input: string, options: SplitAtomOptions = {}): AtomInputSection[] {
	const stripped = stripLeadingBlankLines(normalizeFallbackInput(input, options));
	const lines = stripped.split("\n");
	const firstLine = (lines[0] ?? "").replace(/\r$/, "");
	if (!firstLine.startsWith(FILE_HEADER_PREFIX)) {
		throw new Error(
			`atom input must begin with "${FILE_HEADER_PREFIX}<path>" on the first non-blank line; got: ${JSON.stringify(
				firstLine.slice(0, 120),
			)}`,
		);
	}

	const sections: AtomInputSection[] = [];
	let currentPath = "";
	let currentLines: string[] = [];
	const flush = () => {
		if (currentPath.length === 0) return;
		const wholeFileOperation = getAtomWholeFileOperation(currentPath, currentLines, options.cwd);
		sections.push({
			path: currentPath,
			diff: currentLines.join("\n"),
			...(wholeFileOperation ? { wholeFileOperation } : {}),
		});
		currentLines = [];
	};

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");
		const headerPath = parseAtomHeaderLine(line, options.cwd);
		if (headerPath !== null) {
			flush();
			currentPath = headerPath;
			continue;
		}
		currentLines.push(rawLine);
	}
	flush();
	return sections;
}

// ═════════════════════════════════════════════════════════════════════════════
// Executor
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecuteAtomSingleOptions {
	session: ToolSession;
	input: string;
	path?: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

interface ReadAtomFileResult {
	exists: boolean;
	rawContent: string;
}

async function readAtomFile(absolutePath: string): Promise<ReadAtomFileResult> {
	try {
		return { exists: true, rawContent: await Bun.file(absolutePath).text() };
	} catch (error) {
		if (isEnoent(error)) return { exists: false, rawContent: "" };
		throw error;
	}
}

function hasAnchorScopedEdit(edits: AtomEdit[]): boolean {
	return edits.some(edit => edit.kind === "set" || edit.kind === "delete" || edit.cursor.kind === "anchor");
}

function formatNoChangeDiagnostic(path: string, result: AtomApplyResult): string {
	let diagnostic = `Edits to ${path} resulted in no changes being made.`;
	if (result.noopEdits && result.noopEdits.length > 0) {
		const details = result.noopEdits
			.map(e => {
				const preview =
					e.current.length > 0
						? `\n  current: ${JSON.stringify(e.current.length > 200 ? `${e.current.slice(0, 200)}…` : e.current)}`
						: "";
				return `Edit ${e.editIndex} (${e.loc}): ${e.reason}.${preview}`;
			})
			.join("\n");
		diagnostic += `\n${details}`;
	}
	return diagnostic;
}

async function executeAtomWholeFileOperation(
	options: ExecuteAtomSingleOptions & AtomInputSection & { wholeFileOperation: AtomWholeFileOperation },
): Promise<AgentToolResult<EditToolDetails, typeof atomEditParamsSchema>> {
	const { session, path: sectionPath, wholeFileOperation } = options;
	const absolutePath = resolvePlanPath(session, sectionPath);

	if (sectionPath.endsWith(".ipynb")) {
		throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
	}

	if (wholeFileOperation.kind === "delete") {
		enforcePlanModeWrite(session, sectionPath, { op: "delete" });
		await assertEditableFile(absolutePath, sectionPath);
		try {
			await fs.unlink(absolutePath);
		} catch (error) {
			if (isEnoent(error)) throw new Error(`File not found: ${sectionPath}`);
			throw error;
		}
		invalidateFsScanAfterDelete(absolutePath);
		return {
			content: [{ type: "text", text: `Deleted ${sectionPath}` }],
			details: { diff: "", op: "delete", meta: outputMeta().get() },
		};
	}

	const destinationPath = wholeFileOperation.destination;
	if (destinationPath.endsWith(".ipynb")) {
		throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
	}

	enforcePlanModeWrite(session, sectionPath, { op: "update", move: destinationPath });
	const absoluteDestinationPath = resolvePlanPath(session, destinationPath);
	if (absoluteDestinationPath === absolutePath) {
		throw new Error("rename path is the same as source path");
	}

	await assertEditableFile(absolutePath, sectionPath);
	try {
		await fs.mkdir(path.dirname(absoluteDestinationPath), { recursive: true });
		await fs.rename(absolutePath, absoluteDestinationPath);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${sectionPath}`);
		throw error;
	}
	invalidateFsScanAfterRename(absolutePath, absoluteDestinationPath);

	return {
		content: [{ type: "text", text: `Moved ${sectionPath} to ${destinationPath}` }],
		details: { diff: "", op: "update", move: destinationPath, meta: outputMeta().get() },
	};
}

async function executeAtomSection(
	options: ExecuteAtomSingleOptions & AtomInputSection,
): Promise<AgentToolResult<EditToolDetails, typeof atomEditParamsSchema>> {
	const { session, path, diff, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;
	if (options.wholeFileOperation) {
		return executeAtomWholeFileOperation({ ...options, wholeFileOperation: options.wholeFileOperation });
	}

	const edits = parseAtom(diff);
	if (edits.length === 0 && diff.trim().length > 0) {
		throw new Error(formatNoAtomEditDiagnostic(path, diff));
	}

	enforcePlanModeWrite(session, path, { op: "update" });

	if (path.endsWith(".ipynb") && edits.length > 0) {
		throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
	}

	const absolutePath = resolvePlanPath(session, path);
	const source = await readAtomFile(absolutePath);
	if (!source.exists && hasAnchorScopedEdit(edits)) {
		throw new Error(`File not found: ${path}`);
	}

	if (source.exists) {
		assertEditableFileContent(source.rawContent, path);
	}

	const { bom, text } = stripBom(source.rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);
	const result = applyAtomEdits(originalNormalized, edits);
	if (originalNormalized === result.lines) {
		throw new Error(formatNoChangeDiagnostic(path, result));
	}

	const finalContent = bom + restoreLineEndings(result.lines, originalEnding);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);

	const diffResult = generateDiffString(originalNormalized, result.lines);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);
	const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${
		preview.preview ? "" : " (no textual diff preview)"
	}`;
	const warningsBlock = result.warnings?.length ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n\nDiff preview:\n${preview.preview}` : "";
	const resultText = source.exists ? `Updated ${path}` : `Created ${path}`;

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
			op: source.exists ? "update" : "create",
			meta,
		},
	};
}

export async function executeAtomSingle(
	options: ExecuteAtomSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof atomEditParamsSchema>> {
	const sections = splitAtomInputs(options.input, { cwd: options.session.cwd, path: options.path });
	if (sections.length === 1) {
		const [section] = sections;
		return executeAtomSection({ ...options, ...section });
	}

	const results = [];
	for (const section of sections) {
		results.push({
			path: section.path,
			result: await executeAtomSection({ ...options, ...section }),
		});
	}

	return {
		content: [
			{
				type: "text",
				text: results.map(({ result }) => getTextContent(result)).join("\n\n"),
			},
		],
		details: {
			diff: results.map(({ result }) => getEditDetails(result).diff).join("\n"),
			perFileResults: results.map(({ path, result }) => {
				const details = getEditDetails(result);
				return {
					path,
					diff: details.diff,
					firstChangedLine: details.firstChangedLine,
					diagnostics: details.diagnostics,
					op: details.op,
					move: details.move,
					meta: details.meta,
				};
			}),
		},
	};
}
