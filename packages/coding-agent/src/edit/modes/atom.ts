/**
 * Atom edit mode.
 *
 * Single-string compact wire format. Each file section starts with `---path`;
 * each following line is one statement:
 *
 *   @Lid                    move cursor to just after the anchored line
 *   Lid=TEXT                set the anchored line to TEXT and move cursor after it
 *   -Lid                    delete the anchored line and move cursor to its slot
 *   LidA..LidB=TEXT         replace a range; following \TEXT lines continue it
 *   \TEXT                   append TEXT to the active replacement (set or range)
 *   +TEXT                   insert TEXT at the cursor
 *   ^                       move cursor to beginning of file
 *   $                       move cursor to end of file
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

// Sentinel hash used for interior line anchors synthesized from `-LidA..LidB`
// range deletes. validateAtomAnchors recognizes this and skips hash checking
// (only the start and end Lids' hashes are validated by the user).
const RANGE_INTERIOR_HASH = "**";

interface ParsedAnchor {
	line: number;
	hash: string;
}

type ParsedOp = { op: "set"; text: string; allowOldNewRepair: boolean } | { op: "delete" };

type AnchorStmt =
	| { kind: "bare_anchor"; anchor: ParsedAnchor; lineNum: number }
	| { kind: "anchor_op"; anchor: ParsedAnchor; op: ParsedOp; lineNum: number }
	| { kind: "before_anchor"; anchor: ParsedAnchor; lineNum: number }
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
	separator: "=" | "|";
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

type AtomCursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "anchor"; anchor: Anchor }
	| { kind: "before_anchor"; anchor: Anchor };

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
	if (cursor.kind === "anchor") return { kind: "anchor", anchor: { ...cursor.anchor } };
	if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}

function parseLidStmt(body: string, lineNum: number): ParsedStmt[] | null {
	const m = LID_RE.exec(body);
	if (!m) return null;

	const ln = Number.parseInt(m[1], 10);
	const hash = m[2];
	const rest = body.slice(m[0].length);
	const anchor = { line: ln, hash };

	// Range replace: `LidA..LidB=TEXT` deletes the inclusive range LidA..LidB
	// and inserts TEXT in its place. Following insert statements append more
	// replacement lines through the normal hunk reorder path. Legacy `|` is
	// accepted as a set separator for parity with single-line `Lid|TEXT`.
	// Bare `LidA..LidB` recovers the common missing-`-` typo for range delete.
	if (rest.startsWith("..")) {
		const m2 = LID_RE.exec(rest.slice(2));
		if (m2) {
			const endLn = Number.parseInt(m2[1], 10);
			const endHash = m2[2];
			const after = rest.slice(2 + m2[0].length);
			const range = `${ln}${hash}..${endLn}${endHash}`;
			if (endLn < ln) {
				throw new Error(
					`Diff line ${lineNum}: range \`${range}\` ends before it starts. Use \`LidA..LidB=TEXT\` with LidA's line number ≤ LidB's.`,
				);
			}
			if (endLn === ln && endHash !== hash) {
				throw new Error(
					`Diff line ${lineNum}: range \`${range}\` uses two different hashes for the same line. Copy the same Lid at both endpoints or use \`${ln}${hash}=TEXT\` for a single-line replacement.`,
				);
			}

			const stmts: ParsedStmt[] = [];
			for (let l = ln; l <= endLn; l++) {
				const h = l === ln ? hash : l === endLn ? endHash : RANGE_INTERIOR_HASH;
				stmts.push({
					kind: "anchor_op",
					anchor: { line: l, hash: h },
					op: { op: "delete" },
					lineNum,
				});
			}

			if (after.trim().length === 0) return stmts;

			const replacement = /^[ \t]*([=|])(.*)$/.exec(after);
			if (replacement) {
				if (replacement[2].includes("\r")) {
					throw new Error(`Diff line ${lineNum}: set value contains a carriage return; use a single-line value.`);
				}
				stmts.push({ kind: "insert", text: replacement[2], lineNum });
				return stmts;
			}
		}
	}

	if (rest.length === 0) {
		return [{ kind: "bare_anchor", anchor, lineNum }];
	}

	const replacement = /^[ \t]*([=|])(.*)$/.exec(rest);
	if (replacement) {
		return [
			{
				kind: "anchor_op",
				anchor,
				op: { op: "set", text: replacement[2], allowOldNewRepair: replacement[1] === "|" },
				lineNum,
			},
		];
	}

	// Compound shorthand: `Lid+TEXT` collapses cursor-after-Lid + insert TEXT.
	// Models sometimes write a run like `103rd=A` / `103rd+B` / `103rd+C` to
	// mean "set 103 to A, then insert B and C below it". Treat each `Lid+...`
	// as an independent cursor-move + insert; this matches semantics of the
	// canonical `@Lid` + `+TEXT` two-line form.
	if (rest[0] === "+") {
		return [
			{ kind: "bare_anchor", anchor, lineNum },
			{ kind: "insert", text: rest.slice(1), lineNum },
		];
	}

	return null;
}

function parseDeleteStmt(body: string, lineNum: number): ParsedStmt[] | null {
	const trimmedBody = body.trimStart();

	// Range delete: `-LidA..LidB` deletes the contiguous range LidA..LidB inclusive.
	const rangeRe = /^([1-9]\d*)([a-z]{2})\.\.([1-9]\d*)([a-z]{2})$/;
	const rangeMatch = rangeRe.exec(trimmedBody);
	if (rangeMatch) {
		const startLine = Number.parseInt(rangeMatch[1], 10);
		const startHash = rangeMatch[2];
		const endLine = Number.parseInt(rangeMatch[3], 10);
		const endHash = rangeMatch[4];
		if (endLine < startLine) {
			throw new Error(
				`Diff line ${lineNum}: range \`-${startLine}${startHash}..${endLine}${endHash}\` ends before it starts. Use \`-LidA..LidB\` with LidA's line number ≤ LidB's.`,
			);
		}
		if (endLine === startLine && endHash !== startHash) {
			throw new Error(
				`Diff line ${lineNum}: range \`-${startLine}${startHash}..${endLine}${endHash}\` uses two different hashes for the same line. Copy the same Lid at both endpoints or use \`-${startLine}${startHash}\` for a single-line delete.`,
			);
		}
		const stmts: ParsedStmt[] = [];
		for (let ln = startLine; ln <= endLine; ln++) {
			const hash = ln === startLine ? startHash : ln === endLine ? endHash : RANGE_INTERIOR_HASH;
			stmts.push({
				kind: "anchor_op",
				anchor: { line: ln, hash },
				op: { op: "delete" },
				lineNum,
			});
		}
		return stmts;
	}

	// `-LidA..LidB|TEXT` and `-LidA..LidB=TEXT` are not valid: ranges have no
	// `|` (delete-with-old) form. Models reach for these when trying to
	// "delete the range and replace with TEXT" — point at the `LidA..LidB=TEXT`
	// shorthand instead.
	const rangeWithSuffix = /^([1-9]\d*)([a-z]{2})\.\.([1-9]\d*)([a-z]{2})[ \t]*[=|](.*)$/.exec(trimmedBody);
	if (rangeWithSuffix) {
		const lidA = `${rangeWithSuffix[1]}${rangeWithSuffix[2]}`;
		const lidB = `${rangeWithSuffix[3]}${rangeWithSuffix[4]}`;
		const text = rangeWithSuffix[5];
		throw new Error(
			`Diff line ${lineNum}: \`-${lidA}..${lidB}\` cannot have a \`|\`/\`=\` suffix. To delete the range, use \`-${lidA}..${lidB}\` alone. To replace the range with one new line, drop the leading \`-\` and use \`${lidA}..${lidB}=${text}\`.`,
		);
	}

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

function parseIndentedHashlineStmt(line: string, lineNum: number): ParsedStmt[] | null {
	const trimmed = line.trimStart();
	if (trimmed === line) return null;
	const stmts = parseLidStmt(trimmed, lineNum);
	if (!stmts) return null;
	const safeHashlineEcho = stmts.every(
		stmt => stmt.kind === "bare_anchor" || (stmt.kind === "anchor_op" && stmt.op.op === "set"),
	);
	return safeHashlineEcho ? stmts : null;
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

	// `# ...` comments are silently ignored. Models often add section headers
	// or annotations like `# Test 1: replace enum`; treating these as literal
	// inserts corrupts files, and the canonical syntax has no comment op.
	if (line[0] === "#") return [];

	const indentedHashline = parseIndentedHashlineStmt(line, lineNum);
	if (indentedHashline) return indentedHashline;

	// `+TEXT` inserts at the cursor. Everything after `+` is content. A
	// `+Lid|TEXT` or `+Lid=TEXT` line is a diff-ish add (unified-diff trap):
	// emit a tagged stmt so the normalizer can fuse it with a preceding `-Lid`.
	if (line[0] === "+") {
		const body = line.slice(1);
		if (body.startsWith(RANGE_CONTINUATION_SENTINEL)) {
			return [{ kind: "insert", text: body.slice(RANGE_CONTINUATION_SENTINEL.length), lineNum }];
		}
		const m = LID_RE.exec(body);
		if (m) {
			const sep = body[m[0].length];
			if (sep === "=" || sep === "|") {
				const ln = Number.parseInt(m[1], 10);
				const text = body.slice(m[0].length + 1);
				return [{ kind: "diffish_add", anchor: { line: ln, hash: m[2] }, separator: sep, text, lineNum }];
			}
		}

		// Auto-fix: `+@Lid` and `+-Lid` are almost always typos where the agent
		// prefixed a cursor-move or delete op with `+`. Insert content matching
		// these op shapes is essentially never legitimate in source code, and
		// silently emitting them as literal text corrupts the file (e.g. a stray
		// `@12ly` line in a C++ source). Split into the op + a blank `+` insert
		// so the line count of the edit script is preserved for any downstream
		// offset-sensitive logic.
		if (body.length > 1 && (body[0] === "@" || body[0] === "-")) {
			try {
				const opStmts = parseDiffLine(body, lineNum);
				const allOps = opStmts.length > 0 && opStmts.every(s => s.kind !== "insert" && s.kind !== "diffish_add");
				if (allOps) {
					return [...opStmts, { kind: "insert", text: "", lineNum }];
				}
			} catch {
				// Body looked op-shaped but failed to parse; fall through to literal insert.
			}
		}
		return [{ kind: "insert", text: body, lineNum }];
	}

	// Canonical file-scope locators.
	if (line === "^") return [{ kind: "bof", lineNum }];
	if (line === "$") return [{ kind: "eof", lineNum }];

	// Compound shorthand: `^+TEXT` and `$+TEXT` collapse a file-scope cursor
	// move and an insert onto one line. Models occasionally do this when
	// creating files from scratch (`^+content`) instead of the canonical
	// `^\n+content`. No legitimate op line starts with `^+` or `$+`, so the
	// expansion is unambiguous.
	if (line.length >= 2 && (line[0] === "^" || line[0] === "$") && line[1] === "+") {
		const cursor: ParsedStmt = line[0] === "^" ? { kind: "bof", lineNum } : { kind: "eof", lineNum };
		return [cursor, { kind: "insert", text: line.slice(2), lineNum }];
	}

	// `^=TEXT` and `$=TEXT` are not valid: `^` and `$` are cursor moves only.
	// Models reach for these when trying to "replace the last line" or
	// "replace the first line"; emit a clear diagnostic instead of falling
	// through to "unrecognized op".
	if (line.length >= 2 && (line[0] === "^" || line[0] === "$") && line[1] === "=") {
		const where = line[0] === "^" ? "first" : "last";
		const sym = line[0];
		throw new Error(
			`Diff line ${lineNum}: \`${sym}=TEXT\` is not a valid op. \`${sym}\` only moves the cursor (${sym === "^" ? "BOF" : "EOF"}); it cannot replace a line. To replace the ${where} line, use its Lid (e.g. \`5xx=TEXT\`). To insert at ${sym === "^" ? "BOF" : "EOF"}, use \`${sym}\` followed by \`+TEXT\` on the next line.`,
		);
	}

	// `^Lid` cursor moves BEFORE the anchored line (insert above). Compound
	// shorthand `^Lid+TEXT` collapses the cursor move and an insert into one
	// line. `^Lid=TEXT` and `^Lid|TEXT` are flagged as ambiguous: pick either
	// `^Lid` (cursor before) + `+TEXT`, or `Lid=TEXT` (replace in place).
	if (line[0] === "^" && line.length > 1) {
		const m = LID_RE.exec(line.slice(1));
		if (m) {
			const ln = Number.parseInt(m[1], 10);
			const hash = m[2];
			const sep = line[1 + m[0].length];
			if (sep === undefined) {
				return [{ kind: "before_anchor", anchor: { line: ln, hash }, lineNum }];
			}
			if (sep === "+") {
				const text = line.slice(1 + m[0].length + 1);
				return [
					{ kind: "before_anchor", anchor: { line: ln, hash }, lineNum },
					{ kind: "insert", text, lineNum },
				];
			}
			if (sep === "=" || sep === "|") {
				throw new Error(
					`Diff line ${lineNum}: \`^${ln}${hash}${sep}...\` mixes \`^Lid\` (cursor before line) with \`Lid=TEXT\` (replace line). Pick one: \`^${ln}${hash}\` then \`+TEXT\` on the next line to insert above; or \`${ln}${hash}=TEXT\` to replace the line in place.`,
				);
			}
		}
	}

	// `-Lid` deletes the anchored line. Leniently accept `- Lid` and the
	// historical `-Lid TEXT` delete-then-insert recovery.
	if (line[0] === "-") {
		const parsed = parseDeleteStmt(line.slice(1), lineNum);
		if (parsed) return parsed;
		throw new Error(`Diff line ${lineNum}: \`-\` must be followed by a Lid (e.g. \`-5xx\`). Got "${raw}".`);
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
		if (lidStmt) return lidStmt;

		throwMalformedLidDiagnostic(line, lineNum, raw);
	}

	// Canonical `@Lid` cursor moves. Leniently recover `@Lid=TEXT`,
	// `@Lid|TEXT`, `@$`, and `@^`.
	if (line[0] === "@") {
		const body = line.slice(1);
		if (body === "^") return [{ kind: "bof", lineNum }];
		if (body === "$") return [{ kind: "eof", lineNum }];
		const lidStmt = parseLidStmt(body, lineNum);
		if (lidStmt) return lidStmt;
		throwMalformedLidDiagnostic(line, lineNum, raw);
	}

	// `Lid=TEXT` sets the anchored line. Legacy `Lid|TEXT` remains accepted.
	// A bare `Lid` is a cursor move.
	const lidStmt = parseLidStmt(line, lineNum);
	if (lidStmt) return lidStmt;

	if (/^[a-z]{2}(?=[ \t]*[=|])/.test(line) || /^[1-9]\d*(?=[ \t]*[=|]|$)/.test(line)) {
		throwMalformedLidDiagnostic(line, lineNum, raw);
	}

	// Reject any line that doesn't match a recognized op. Common case: a model
	// emitted multi-line content after a `Lid=` or similar without `+` prefixes,
	// or pasted raw context. Silently treating these as inserts corrupts files.
	const preview = line.length > 80 ? `${line.slice(0, 80)}…` : line;
	const trailingDash = /^([1-9]\d*[a-z]{2})-\s*$/.exec(line);
	if (trailingDash) {
		throw new Error(
			`Diff line ${lineNum}: \`${line}\` looks like a delete with the operator on the wrong side. Use \`-${trailingDash[1]}\` to delete that line.`,
		);
	}
	throw new Error(
		`Diff line ${lineNum}: unrecognized op. Lines must start with \`+\`, \`-\`, \`@\`, \`$\`, \`^\`, or a Lid (\`Lid=TEXT\`). To insert literal text use \`+TEXT\`. Got "${preview}".`,
	);
}

// Lines that look like recognized atom ops. Used to delimit range-replace
// recovery continuation: after `LidA..LidB=TEXT` (or legacy `|` separator),
// is treated as literal replacement text for backward compatibility.
const OP_LINE_HEAD_RE = /^([+\-@$^!]|[1-9]\d*[a-z]{2}|[ \t]*$)/;
const RANGE_CONTINUATION_SENTINEL = "\u0000";

function isRangeReplaceStart(line: string): boolean {
	return /^[1-9]\d*[a-z]{2}\.\.[1-9]\d*[a-z]{2}[ \t]*[=|]/.test(line);
}

// A single-line `Lid=TEXT` (or legacy `Lid|TEXT`, with optional leading `@`)
// also opens a replacement that `\TEXT` continuation lines may extend. The
// continuation lines become inserts at the cursor (which sits on the just-set
// line), turning `Lid=A` + `\B` + `\C` into "set the line to A, then insert B
// and C below it" — i.e. a multi-line rewrite of one anchor without forcing
// the user to switch to the `LidA..LidB=` range form.
function isReplaceStart(line: string): boolean {
	if (isRangeReplaceStart(line)) return true;
	const stripped = line.startsWith("@") ? line.slice(1) : line;
	return /^[1-9]\d*[a-z]{2}[ \t]*[=|]/.test(stripped);
}

// Explicit continuation uses `\TEXT` after a replacement op (`Lid=FIRST` or
// `LidA..LidB=FIRST`). The leading backslash is the continuation marker; the
// rest of the line is inserted literally, so `\\TEXT` inserts a line starting
// with `\TEXT`. Raw unprefixed continuation remains an undocumented
// best-effort recovery for range replacements only, kept for old transcripts.
function preprocessRangeReplaceContinuation(diff: string): string {
	const lines = diff.split("\n");
	let inRangeReplace = false;
	let inReplace = false;
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

		if (line.startsWith("\\")) {
			if (!inReplace) {
				throw new Error(
					`Diff line ${i + 1}: \\TEXT continuation is only valid immediately after a Lid=TEXT or LidA..LidB=FIRST_LINE replacement.`,
				);
			}
			lines[i] = `+${RANGE_CONTINUATION_SENTINEL}${rawLine.slice(1)}`;
			continue;
		}

		if (inRangeReplace) {
			if (line.length === 0 || OP_LINE_HEAD_RE.test(line)) {
				inRangeReplace = isRangeReplaceStart(line);
				inReplace = isReplaceStart(line);
				continue;
			}

			lines[i] = `+${RANGE_CONTINUATION_SENTINEL}${rawLine}`;
			continue;
		}

		inRangeReplace = isRangeReplaceStart(line);
		inReplace = isReplaceStart(line);
	}
	return lines.join("\n");
}

function tokenizeDiff(diff: string): ParsedStmt[] {
	const out: ParsedStmt[] = [];
	const lines = preprocessRangeReplaceContinuation(diff).split("\n");
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
// `set`; malformed standalone or mismatched `+Lid|TEXT`/`+Lid=TEXT` lines
// throw instead of silently dropping the Lid prefix.
function normalizeHunks(stmts: ParsedStmt[]): ParsedStmt[] {
	const isDelete = (s: ParsedStmt): boolean =>
		(s.kind === "anchor_op" && s.op.op === "delete") || s.kind === "delete_with_old";
	const isAdd = (s: ParsedStmt): boolean => s.kind === "insert" || s.kind === "diffish_add";
	const formatDiffishAdd = (stmt: DiffishAddStmt): string =>
		`+${stmt.anchor.line}${stmt.anchor.hash}${stmt.separator}${stmt.text}`;
	const out: ParsedStmt[] = [];
	let i = 0;
	while (i < stmts.length) {
		const stmt = stmts[i];
		if (!isDelete(stmt)) {
			if (stmt.kind === "diffish_add") {
				const lid = `${stmt.anchor.line}${stmt.anchor.hash}`;
				throw new Error(
					`Diff line ${stmt.lineNum}: \`${formatDiffishAdd(stmt)}\` is unified-diff syntax, not edit syntax. To replace a line, use \`${lid}=TEXT\`; to insert literal text, use \`+TEXT\` without a Lid prefix.`,
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
					`Diff line ${add.lineNum}: \`${formatDiffishAdd(add)}\` references a Lid not in the preceding delete run. Use plain \`+TEXT\` for replacement lines, or delete \`${lid}\` before using a unified-diff recovery line for that Lid.`,
				);
			}
		}
		// Split the delete run into file-contiguous sub-runs. The block
		// reorder (inserts land at the FIRST delete's slot) is meaningful only
		// when the deletes describe a single contiguous file range. When the
		// agent stacks deletes that target far-apart lines (e.g. `-186 -197
		// -198 -199` to remove a debug line at 186 AND replace 197-199), each
		// far-apart delete moves the cursor on its own; only the LAST
		// contiguous group should attract the inserts.
		const subruns = splitContiguousDeletes(deletes);
		for (let r = 0; r < subruns.length - 1; r++) {
			for (const d of subruns[r]) out.push(d);
		}
		const lastDeletes = subruns[subruns.length - 1];

		// Single-line case: 1 delete in the last sub-run + 1 diffish_add same Lid → fuse to set.
		if (lastDeletes.length === 1 && adds.length === 1 && adds[0].kind === "diffish_add") {
			const dAnchor = (lastDeletes[0] as { anchor: ParsedAnchor }).anchor;
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
		// Block: emit lastDeletes[0], then all inserts (which land at lastDeletes[0]'s slot
		// because the cursor binds to lastDeletes[0] before the inserts), then the
		// remaining lastDeletes.
		out.push(lastDeletes[0]);
		for (const add of adds) {
			const text = add.kind === "insert" ? add.text : (add as DiffishAddStmt).text;
			out.push({ kind: "insert", text, lineNum: add.lineNum });
		}
		for (let j = 1; j < lastDeletes.length; j++) {
			out.push(lastDeletes[j]);
		}
	}
	return out;
}

function makeAnchor(anchor: ParsedAnchor): Anchor {
	return { line: anchor.line, hash: anchor.hash };
}

function splitContiguousDeletes(deletes: ParsedStmt[]): ParsedStmt[][] {
	if (deletes.length === 0) return [];
	const getLine = (s: ParsedStmt): number => {
		if (s.kind === "anchor_op") return s.anchor.line;
		if (s.kind === "delete_with_old") return s.anchor.line;
		throw new Error("internal: splitContiguousDeletes received non-delete stmt");
	};
	const subruns: ParsedStmt[][] = [];
	let current: ParsedStmt[] = [deletes[0]];
	for (let i = 1; i < deletes.length; i++) {
		if (getLine(deletes[i]) === getLine(deletes[i - 1]) + 1) {
			current.push(deletes[i]);
		} else {
			subruns.push(current);
			current = [deletes[i]];
		}
	}
	subruns.push(current);
	return subruns;
}

// ═══════════════════════════════════════════════════════════════════════════
// Build cursor-program from ParsedStmt[]
// ═══════════════════════════════════════════════════════════════════════════

export function parseAtom(diff: string): AtomEdit[] {
	return parseAtomWithWarnings(diff).edits;
}

export function parseAtomWithWarnings(diff: string): { edits: AtomEdit[]; warnings: string[] } {
	const edits: AtomEdit[] = [];
	const warnings: string[] = [];
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
			throw new Error("Internal edit error: unresolved diff-ish add reached parser.");
		}

		if (stmt.kind === "before_anchor") {
			cursor = { kind: "before_anchor", anchor: makeAnchor(stmt.anchor) };
			continue;
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

	return { edits, warnings };
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
	if (edit.cursor.kind === "anchor" || edit.cursor.kind === "before_anchor") return [edit.cursor.anchor];
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
			if (anchor.hash === RANGE_INTERIOR_HASH) continue;
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
	if (edit.cursor.kind !== "anchor" && edit.cursor.kind !== "before_anchor") {
		throw new Error("Internal edit error: file-scoped insert reached anchor application.");
	}
	return edit.cursor.anchor;
}

// Heuristic: detect (and when safe, auto-fix) lines that became adjacent
// duplicates of themselves after the edit, when they were not adjacent
// duplicates before. This is the signature of a botched block rewrite that
// missed one delete on the front or back of the deletion range, leaving a
// stale copy of a line the agent already re-emitted (e.g. inserting a new
// closing `}` while the original `}` was never deleted, producing `}\n}`).
//
// Auto-fix is gated on bracket balance: we only remove the duplicate line if
// its removal restores the original file's `{}`/`()`/`[]` delta. That makes
// the fix safe in the common case (a stray closing brace shifts balance by
// one) and conservative when the duplicate is intentional (balance unchanged
// → warning only). When two adjacent lines are textually identical, removing
// either yields the same content, so we don't have to decide which is "the
// stale copy" — we just remove one and verify balance restores.
function detectAndAutoFixDuplicates(
	originalLines: string[],
	finalLines: string[],
): { fixed: string[] | null; warnings: string[] } {
	const countAdjacent = (lines: string[]): Map<string, number> => {
		const counts = new Map<string, number>();
		for (let i = 0; i + 1 < lines.length; i++) {
			if (lines[i] !== lines[i + 1]) continue;
			if (lines[i].trim().length === 0) continue;
			counts.set(lines[i], (counts.get(lines[i]) ?? 0) + 1);
		}
		return counts;
	};

	const computeBalance = (lines: string[]): { brace: number; paren: number; bracket: number } => {
		let brace = 0;
		let paren = 0;
		let bracket = 0;
		for (const line of lines) {
			for (const ch of line) {
				if (ch === "{") brace++;
				else if (ch === "}") brace--;
				else if (ch === "(") paren++;
				else if (ch === ")") paren--;
				else if (ch === "[") bracket++;
				else if (ch === "]") bracket--;
			}
		}
		return { brace, paren, bracket };
	};

	const balancesEqual = (
		a: { brace: number; paren: number; bracket: number },
		b: { brace: number; paren: number; bracket: number },
	): boolean => a.brace === b.brace && a.paren === b.paren && a.bracket === b.bracket;

	const orig = countAdjacent(originalLines);
	const fin = countAdjacent(finalLines);
	const newDupPositions: number[] = [];
	for (let i = 0; i + 1 < finalLines.length; i++) {
		if (finalLines[i] !== finalLines[i + 1]) continue;
		if (finalLines[i].trim().length === 0) continue;
		const text = finalLines[i];
		if ((fin.get(text) ?? 0) <= (orig.get(text) ?? 0)) continue;
		newDupPositions.push(i);
	}

	if (newDupPositions.length === 0) return { fixed: null, warnings: [] };

	const formatPreview = (text: string): string => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);

	// Auto-fix only when there is exactly one new adjacent duplicate AND the
	// edit shifted bracket balance. Removing one of the two identical lines
	// must restore the original delta exactly.
	if (newDupPositions.length === 1) {
		const pos = newDupPositions[0];
		const origBalance = computeBalance(originalLines);
		const finalBalance = computeBalance(finalLines);
		if (!balancesEqual(origBalance, finalBalance)) {
			const trial = finalLines.slice(0, pos).concat(finalLines.slice(pos + 1));
			if (balancesEqual(computeBalance(trial), origBalance)) {
				return {
					fixed: trial,
					warnings: [
						`Auto-fixed: removed duplicate line ${pos + 1} (${formatPreview(finalLines[pos])}); the edit left two adjacent identical lines and bracket balance was off. Verify the result.`,
					],
				};
			}
		}
	}

	const warnings = newDupPositions.slice(0, 3).map(pos => {
		return `Suspicious duplicate: lines ${pos + 1} and ${pos + 2} are both ${formatPreview(finalLines[pos])}. The edit may have left a stale copy of a line you meant to replace — verify the result.`;
	});
	return { fixed: null, warnings };
}

export function applyAtomEdits(text: string, edits: AtomEdit[]): AtomApplyResult {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const originalLines = fileLines.slice();
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
		if (edit.kind === "insert" && edit.cursor.kind !== "anchor" && edit.cursor.kind !== "before_anchor") {
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
		const beforeLines: string[] = [];
		const afterLines: string[] = [];

		for (const { edit } of bucket) {
			switch (edit.kind) {
				case "insert":
					if (edit.cursor.kind === "before_anchor") {
						beforeLines.push(edit.text);
					} else {
						afterLines.push(edit.text);
					}
					break;
				case "set":
					replacement = [edit.allowOldNewRepair ? repairAtomOldNewSetLine(currentLine, edit.text) : edit.text];
					replacementSet = true;
					anchorMutated = true;
					break;
				case "delete":
					// `-Lid|OLD` / `-Lid=OLD`: the OLD payload is informational only.
					// The Lid hash already validates the line content (and auto-rebases
					// when lines have shifted), so we ignore any OLD mismatch here.
					replacement = [];
					replacementSet = true;
					anchorMutated = true;
					break;
			}
		}

		const replacementProducesNoChange =
			beforeLines.length === 0 &&
			afterLines.length === 0 &&
			replacement.length === 1 &&
			replacement[0] === currentLine;
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

		const combined = [...beforeLines, ...replacement, ...afterLines];
		fileLines.splice(idx, 1, ...combined);
		if (anchorMutated || beforeLines.length > 0) {
			trackFirstChanged(line);
		} else if (afterLines.length > 0) {
			trackFirstChanged(line + 1);
		}
		if (!replacementSet && beforeLines.length === 0 && afterLines.length === 0) continue;
	}

	const fileFirstChangedLine = applyFileCursorInserts(fileLines, fileInserts);
	if (fileFirstChangedLine !== undefined) trackFirstChanged(fileFirstChangedLine);

	const dupCheck = detectAndAutoFixDuplicates(originalLines, fileLines);
	if (dupCheck.fixed !== null) {
		fileLines.length = 0;
		fileLines.push(...dupCheck.fixed);
	}
	for (const w of dupCheck.warnings) warnings.push(w);

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
		throw new Error(`Input header "${FILE_HEADER_PREFIX}" is empty; provide a file path.`);
	}
	return parsedPath;
}

function parseSingleAtomPathArgument(rawPath: string, directive: string, lineNum: number, cwd?: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		throw new Error(`Diff line ${lineNum}: ${directive} requires exactly one non-empty destination path.`);
	}

	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) {
			throw new Error(`Diff line ${lineNum}: ${directive} requires exactly one destination path.`);
		}
	} else if (/\s/.test(trimmed)) {
		throw new Error(`Diff line ${lineNum}: ${directive} requires exactly one destination path.`);
	}

	const destination = normalizeAtomPath(trimmed, cwd);
	if (destination.length === 0) {
		throw new Error(`Diff line ${lineNum}: ${directive} requires exactly one non-empty destination path.`);
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
		throw new Error(`Diff line ${lineNum}: ${REMOVE_FILE_OPERATION} does not take a destination path.`);
	}

	if (line === MOVE_FILE_OPERATION) {
		throw new Error(`Diff line ${lineNum}: ${MOVE_FILE_OPERATION} requires exactly one non-empty destination path.`);
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
					`Edit section ${sectionPath}: use only one ${REMOVE_FILE_OPERATION} or ${MOVE_FILE_OPERATION} operation.`,
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
			`Edit section ${sectionPath} mixes ${operationToken} with line edits; ${REMOVE_FILE_OPERATION} and ${MOVE_FILE_OPERATION} must be the only operation in their section.`,
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
		if (/^\$\+.*$/.test(line)) return true;
		if (/^\^[1-9]\d*[a-z]{2}(?:\+.*)?$/.test(line)) return true;
		if (/^- ?[1-9]\d*[a-z]{2}(?:\.\.[1-9]\d*[a-z]{2})?(?:[ \t]*[=|].*| .*)?$/.test(line)) return true;
		if (/^@?[1-9]\d*[a-z]{2}(?:\+.*|[ \t]*[=|].*|\.\.[1-9]\d*[a-z]{2}[ \t]*=.*)?$/.test(line)) return true;
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

function normalizeStandaloneFileOpInput(input: string, cwd?: string): string | null {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const lines = stripped.split("\n");
	let firstIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].replace(/\r$/, "").trim().length > 0) {
			firstIdx = i;
			break;
		}
	}
	if (firstIdx === -1) return null;
	const firstLine = lines[firstIdx].replace(/\r$/, "");
	const remaining = lines.slice(firstIdx + 1).join("\n");
	if (remaining.trim().length > 0) return null;

	const rmMatch = /^!rm\s+(\S.*)$/.exec(firstLine);
	if (rmMatch) {
		const sourcePath = parseSingleAtomPathArgument(rmMatch[1], REMOVE_FILE_OPERATION, firstIdx + 1, cwd);
		return `${FILE_HEADER_PREFIX}${sourcePath}\n${REMOVE_FILE_OPERATION}`;
	}

	const mvMatch = /^!mv\s+(\S+)\s+(\S.*)$/.exec(firstLine);
	if (mvMatch) {
		const sourcePath = parseSingleAtomPathArgument(mvMatch[1], MOVE_FILE_OPERATION, firstIdx + 1, cwd);
		const destPath = parseSingleAtomPathArgument(mvMatch[2], MOVE_FILE_OPERATION, firstIdx + 1, cwd);
		return `${FILE_HEADER_PREFIX}${sourcePath}\n${MOVE_FILE_OPERATION} ${destPath}`;
	}

	return null;
}

function normalizeFallbackInput(input: string, options: SplitAtomOptions): string {
	if (hasAtomHeaderLine(input)) return input;
	const standalone = normalizeStandaloneFileOpInput(input, options.cwd);
	if (standalone !== null) return standalone;
	if (!options.path || !containsRecognizableAtomOperations(input)) {
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
		const preview = JSON.stringify(firstLine.slice(0, 120));
		throw new Error(
			`input must begin with "${FILE_HEADER_PREFIX}<path>" on the first non-blank line; got: ${preview}.\n` +
				`Example: "${FILE_HEADER_PREFIX}src/foo.ts" then your edit ops on the following lines. ` +
				`To delete a file: "${FILE_HEADER_PREFIX}<path>\\n!rm". To rename: "${FILE_HEADER_PREFIX}<src>\\n!mv <dest>".`,
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
	return edits.some(
		edit =>
			edit.kind === "set" ||
			edit.kind === "delete" ||
			edit.cursor.kind === "anchor" ||
			edit.cursor.kind === "before_anchor",
	);
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
		const setNoops = result.noopEdits.filter(e => e.reason.startsWith("replacement is identical"));
		if (setNoops.length > 0) {
			diagnostic +=
				"\n\nHint: each `Lid=TEXT` you emit MUST contain text that differs from the line currently anchored by Lid. " +
				"Do not echo lines back from `read` output unchanged. If you intended to leave a line as-is, omit it from the patch.";
		}
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

async function preflightAtomSection(options: ExecuteAtomSingleOptions & AtomInputSection): Promise<void> {
	const { session, path: sectionPath, diff } = options;
	if (options.wholeFileOperation) {
		const { wholeFileOperation } = options;
		const absolutePath = resolvePlanPath(session, sectionPath);
		if (sectionPath.endsWith(".ipynb")) {
			throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
		}
		if (wholeFileOperation.kind === "delete") {
			enforcePlanModeWrite(session, sectionPath, { op: "delete" });
			await assertEditableFile(absolutePath, sectionPath);
			return;
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
		return;
	}

	const { edits } = parseAtomWithWarnings(diff);
	if (edits.length === 0 && diff.trim().length > 0) {
		throw new Error(formatNoAtomEditDiagnostic(sectionPath, diff));
	}

	enforcePlanModeWrite(session, sectionPath, { op: "update" });
	if (sectionPath.endsWith(".ipynb") && edits.length > 0) {
		throw new Error("Cannot edit Jupyter notebooks with the Edit tool. Use the NotebookEdit tool instead.");
	}

	const absolutePath = resolvePlanPath(session, sectionPath);
	const source = await readAtomFile(absolutePath);
	if (!source.exists && hasAnchorScopedEdit(edits)) {
		throw new Error(`File not found: ${sectionPath}`);
	}
	if (source.exists) {
		assertEditableFileContent(source.rawContent, sectionPath);
	}

	const { text } = stripBom(source.rawContent);
	const originalNormalized = normalizeToLF(text);
	const result = applyAtomEdits(originalNormalized, edits);
	if (originalNormalized === result.lines && (result.noopEdits?.length ?? 0) === 0) {
		throw new Error(formatNoChangeDiagnostic(sectionPath, result));
	}
}

async function executeAtomSection(
	options: ExecuteAtomSingleOptions & AtomInputSection,
): Promise<AgentToolResult<EditToolDetails, typeof atomEditParamsSchema>> {
	const { session, path, diff, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;
	if (options.wholeFileOperation) {
		return executeAtomWholeFileOperation({ ...options, wholeFileOperation: options.wholeFileOperation });
	}

	const { edits, warnings: parseWarnings } = parseAtomWithWarnings(diff);
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
		const allNoop = (result.noopEdits?.length ?? 0) > 0;
		if (!allNoop) {
			throw new Error(formatNoChangeDiagnostic(path, result));
		}
		// Every edit was a no-op (TEXT identical to the anchored line). Returning
		// success here breaks retry loops where models hammer the same `Lid=TEXT`
		// when TEXT happens to already match. The response makes the no-op
		// explicit so the model knows nothing changed and to move on.
		return {
			content: [{ type: "text", text: formatNoChangeDiagnostic(path, result) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
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
	const allWarnings = [...parseWarnings, ...(result.warnings ?? [])];
	const warningsBlock = allWarnings.length > 0 ? `\n\nWarnings:\n${allWarnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const resultText = preview.preview ? `${path}:` : source.exists ? `Updated ${path}` : `Created ${path}`;

	return {
		content: [
			{
				type: "text",
				text: `${resultText}${previewBlock}${warningsBlock}`,
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

	for (const section of sections) {
		await preflightAtomSection({ ...options, ...section });
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
