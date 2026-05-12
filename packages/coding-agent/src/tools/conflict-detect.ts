/**
 * Detect and resolve unresolved git merge conflicts that surface in `read`
 * output.
 *
 * Workflow:
 *   1. `read` collects lines from disk as usual.
 *   2. `scanConflictLines` inspects those lines (no extra I/O) for
 *      well-formed `<<<<<<<` / `=======` / `>>>>>>>` blocks.
 *   3. Each completed block is registered with the session's
 *      `ConflictHistory`, which assigns it a stable id.
 *   4. The read output is returned verbatim with a short footer naming
 *      every conflict id surfaced, and the agent calls
 *      `write({ path: "conflict://<id>", content })` to splice the
 *      recorded region with the chosen content.
 *
 * Marker shape is strict: only column-0 markers of the exact prefix length
 * followed by either EOL or a single space + label count. Lines that
 * merely start with `<` or `=` never match.
 */

import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";

export interface ConflictBlock {
	/** 1-indexed line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-indexed line of the `=======` separator. */
	separatorLine: number;
	/** 1-indexed line of the `>>>>>>>` marker. */
	endLine: number;
	/** 1-indexed line of the `|||||||` base marker (diff3 only). */
	baseLine?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

/**
 * Scan an already-collected array of file lines for completed conflict
 * blocks. `firstLineNumber` is the 1-indexed line number of `lines[0]`
 * (so a windowed read starting at line 200 passes `firstLineNumber: 200`).
 *
 * Only fully-closed blocks (opener + separator + closer all present in
 * the window) are returned. A block whose closer is past the window's
 * tail is dropped — the agent will see the open marker and can widen
 * the read.
 */
export function scanConflictLines(lines: readonly string[], firstLineNumber: number): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let phase: "idle" | "ours" | "base" | "theirs" = "idle";
	let partial: {
		startLine: number;
		oursLabel?: string;
		oursLines: string[];
		baseLine?: number;
		baseLabel?: string;
		baseLines?: string[];
		separatorLine?: number;
		theirsLines?: string[];
	} | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const ln = firstLineNumber + i;

		const oursLabel = matchMarker(line, OURS_PREFIX);
		if (oursLabel !== null) {
			partial = { startLine: ln, oursLabel: oursLabel || undefined, oursLines: [] };
			phase = "ours";
			continue;
		}

		if (phase === "idle" || partial === null) continue;

		const baseLabel = matchMarker(line, BASE_PREFIX);
		if (baseLabel !== null) {
			if (phase !== "ours") {
				partial = null;
				phase = "idle";
				continue;
			}
			partial.baseLine = ln;
			partial.baseLabel = baseLabel || undefined;
			partial.baseLines = [];
			phase = "base";
			continue;
		}

		if (line === SEPARATOR) {
			if (phase === "ours" || phase === "base") {
				partial.separatorLine = ln;
				partial.theirsLines = [];
				phase = "theirs";
			} else {
				partial = null;
				phase = "idle";
			}
			continue;
		}

		const theirsLabel = matchMarker(line, THEIRS_PREFIX);
		if (theirsLabel !== null) {
			if (phase === "theirs" && partial.separatorLine !== undefined && partial.theirsLines) {
				blocks.push({
					startLine: partial.startLine,
					separatorLine: partial.separatorLine,
					endLine: ln,
					baseLine: partial.baseLine,
					oursLabel: partial.oursLabel,
					baseLabel: partial.baseLabel,
					theirsLabel: theirsLabel || undefined,
					oursLines: partial.oursLines,
					baseLines: partial.baseLines,
					theirsLines: partial.theirsLines,
				});
			}
			partial = null;
			phase = "idle";
			continue;
		}

		if (phase === "ours") partial.oursLines.push(line);
		else if (phase === "base" && partial.baseLines) partial.baseLines.push(line);
		else if (phase === "theirs" && partial.theirsLines) partial.theirsLines.push(line);
	}

	return blocks;
}

/**
 * Return the label after a marker prefix when the line is a valid
 * column-0 marker, or `null` when it isn't. Strict shape: prefix alone,
 * or prefix + single space + label.
 */
function matchMarker(line: string, prefix: string): string | null {
	if (!line.startsWith(prefix)) return null;
	if (line.length === prefix.length) return "";
	if (line.charCodeAt(prefix.length) !== 32 /* space */) return null;
	return line.slice(prefix.length + 1);
}

/**
 * Recorded conflict block keyed by a session-stable id. The history is
 * append-only; ids stay valid even after later writes resolve other
 * blocks in the same file, so retries don't depend on re-reading.
 */
export interface ConflictEntry extends ConflictBlock {
	id: number;
	absolutePath: string;
	displayPath: string;
}

/** Per-session log of conflict regions surfaced by `read`. */
export class ConflictHistory {
	#nextId = 1;
	#entries = new Map<number, ConflictEntry>();

	/**
	 * Register a conflict block. Returns the (possibly pre-existing) entry
	 * — if the same `absolutePath`+`startLine` was registered before, the
	 * earlier id is reused so a re-read does not inflate the counter or
	 * orphan the prior id. The recorded region is overwritten on re-read
	 * so the splice always reflects the current marker positions on disk.
	 */
	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.#entries.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
				const merged: ConflictEntry = { ...input, id: existing.id };
				this.#entries.set(existing.id, merged);
				return merged;
			}
		}
		const id = this.#nextId++;
		const entry: ConflictEntry = { ...input, id };
		this.#entries.set(id, entry);
		return entry;
	}

	get(id: number): ConflictEntry | undefined {
		return this.#entries.get(id);
	}

	/** Drop a single entry by id. Used after a successful resolve. */
	invalidate(id: number): void {
		this.#entries.delete(id);
	}

	/** Drop every entry referencing `absolutePath`. Used after a successful resolve. */
	invalidatePath(absolutePath: string): void {
		for (const [id, entry] of this.#entries) {
			if (entry.absolutePath === absolutePath) {
				this.#entries.delete(id);
			}
		}
	}
}

/** Lazily attach a `ConflictHistory` to the session and return it. */
export function getConflictHistory(session: ToolSession): ConflictHistory {
	if (!session.conflictHistory) session.conflictHistory = new ConflictHistory();
	return session.conflictHistory;
}

/** A side of a conflict block that `read conflict://N/<scope>` can render. */
export type ConflictScope = "ours" | "theirs" | "base";

const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);

/** Parsed `conflict://<N>` or `conflict://<N>/<scope>` URI. */
export interface ParsedConflictUri {
	id: number;
	scope?: ConflictScope;
}

const CONFLICT_URI_RE = /^conflict:\/\/(.+)$/;

/**
 * Parse a `conflict://<N>` or `conflict://<N>/<scope>` URI.
 *
 * Returns `null` for non-conflict paths; throws `ToolError` for a
 * well-formed scheme with an invalid id or scope so the agent gets a
 * clear actionable message rather than a confusing "not found" later.
 */
export function parseConflictUri(raw: string): ParsedConflictUri | null {
	const match = raw.match(CONFLICT_URI_RE);
	if (!match) return null;
	const tail = match[1];
	const slashIdx = tail.indexOf("/");
	const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
	const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

	if (!/^\d+$/.test(idPart)) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>' (or 'conflict://<N>/<scope>') where N is a positive integer surfaced by a prior \`read\`.`,
		);
	}
	const id = Number.parseInt(idPart, 10);
	if (!Number.isFinite(id) || id < 1) {
		throw new ToolError(`Invalid conflict URI '${raw}': id must be ≥ 1.`);
	}

	let scope: ConflictScope | undefined;
	if (scopePart !== undefined) {
		if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted (e.g. 'conflict://${id}/theirs').`,
			);
		}
		scope = scopePart as ConflictScope;
	}

	return { id, scope };
}

/**
 * Splice the conflict region `[entry.startLine..entry.endLine]` (1-indexed,
 * inclusive of every marker and all sides) out of `originalText` and
 * replace it with `replacement`. A single trailing newline on
 * `replacement` is normalised so the splice rejoins cleanly.
 *
 * Re-validates that the recorded marker lines still look like markers
 * before splicing — if the file has been edited out-of-band and the
 * recorded range no longer brackets a conflict, throw rather than
 * corrupting the file.
 */
export function spliceConflict(originalText: string, entry: ConflictEntry, replacement: string): string {
	const lines = originalText.split("\n");
	const startIdx = entry.startLine - 1;
	const endIdx = entry.endLine - 1;
	if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
		throw new ToolError(
			`Conflict #${entry.id} range [${entry.startLine}..${entry.endLine}] is outside the current file (${lines.length} lines). The file has changed since the conflict was registered — re-read it to pick up the new layout.`,
		);
	}
	if (matchMarker(lines[startIdx], OURS_PREFIX) === null) {
		throw new ToolError(
			`Conflict #${entry.id} stale: line ${entry.startLine} of '${entry.displayPath}' no longer starts with '<<<<<<<'. Re-read the file to re-register the conflict.`,
		);
	}
	if (matchMarker(lines[endIdx], THEIRS_PREFIX) === null) {
		throw new ToolError(
			`Conflict #${entry.id} stale: line ${entry.endLine} of '${entry.displayPath}' no longer starts with '>>>>>>>'. Re-read the file to re-register the conflict.`,
		);
	}

	const trimmed = normalizeTrailingNewline(replacement);
	const replacementLines = trimmed.split("\n");
	const next = [...lines.slice(0, startIdx), ...replacementLines, ...lines.slice(endIdx + 1)];
	return next.join("\n");
}

function normalizeTrailingNewline(replacement: string): string {
	if (replacement.endsWith("\r\n")) return replacement.slice(0, -2);
	if (replacement.endsWith("\n")) return replacement.slice(0, -1);
	return replacement;
}

/**
 * Expand `@ours` / `@theirs` / `@base` / `@both` line tokens against the
 * recorded sections of `entry`. A token only triggers when it is the
 * entire content of a line (after CRLF normalisation), so `@ours` inside
 * actual code is left alone. Other lines pass through verbatim.
 *
 * - `@ours`    → expands to the recorded `oursLines` (in order).
 * - `@theirs`  → expands to the recorded `theirsLines` (in order).
 * - `@base`    → expands to `baseLines`; throws if no base section was
 *               recorded (i.e. the conflict was 2-way, not diff3).
 * - `@both`    → expands to `oursLines` then `theirsLines`.
 */
export function expandContentTokens(content: string, entry: ConflictEntry): string {
	const inputLines = content.split("\n");
	const out: string[] = [];
	for (const rawLine of inputLines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		switch (line) {
			case "@ours":
				out.push(...entry.oursLines);
				break;
			case "@theirs":
				out.push(...entry.theirsLines);
				break;
			case "@base":
				if (!entry.baseLines) {
					throw new ToolError(
						`Conflict #${entry.id} has no base section (2-way merge). \`@base\` is only valid for diff3 conflicts.`,
					);
				}
				out.push(...entry.baseLines);
				break;
			case "@both":
				out.push(...entry.oursLines, ...entry.theirsLines);
				break;
			default:
				out.push(rawLine);
				break;
		}
	}
	return out.join("\n");
}

/** Reconstruct a conflict-marker line from prefix and optional label. */
function markerLine(prefix: string, label: string | undefined): string {
	return label && label.length > 0 ? `${prefix} ${label}` : prefix;
}

/**
 * Materialise a conflict block for `read conflict://<N>` (and its
 * `/ours` / `/theirs` / `/base` scopes).
 *
 * Returns:
 * - `lines`: the lines to render, ordered top-to-bottom.
 * - `startLine`: the 1-indexed file line number `lines[0]` corresponds
 *   to, so the read formatter can label hashline anchors with the
 *   original file positions.
 *
 * Bare (no scope) returns the full block including marker lines. A
 * scoped view returns only that side's body — `base` throws when the
 * recorded conflict is a 2-way merge with no base section.
 */
export function renderConflictRegion(
	entry: ConflictEntry,
	scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
	if (scope === "ours") {
		return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
	}
	if (scope === "theirs") {
		return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 };
	}
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined) {
			throw new ToolError(
				`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
			);
		}
		return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
	}
	const out: string[] = [];
	out.push(markerLine("<<<<<<<", entry.oursLabel));
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(markerLine("|||||||", entry.baseLabel));
		out.push(...entry.baseLines);
	}
	out.push("=======");
	out.push(...entry.theirsLines);
	out.push(markerLine(">>>>>>>", entry.theirsLabel));
	return { lines: out, startLine: entry.startLine };
}

const PREVIEW_SIDE_LINES = 6;

/**
 * Build a compact diff-style footer describing the conflicts registered
 * during a read. Designed to be appended after the file content.
 *
 * Format:
 *
 *     ⚠ N unresolved conflicts detected
 *     - ours = HEAD
 *     - theirs = feature/x
 *     NOTICE: …
 *
 *     ──── #1  L42-48 ────
 *     <<< ours
 *     …ours body…
 *     === base ≡ ours
 *     >>> theirs
 *     …theirs body…
 *
 * Labels are aggregated once at the top from the first entry that has
 * them; when a section body equals another section's body the redundant
 * body is collapsed to `≡ <other>`.
 */
export function formatConflictWarning(entries: readonly ConflictEntry[]): string {
	if (entries.length === 0) return "";
	const out: string[] = [];
	out.push("");
	const word = entries.length === 1 ? "conflict" : "conflicts";
	out.push(`⚠ ${entries.length} unresolved ${word} detected`);

	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) out.push(`- ours = ${oursLabel}`);
	if (theirsLabel) out.push(`- theirs = ${theirsLabel}`);
	if (anyBase) out.push(`- base = ${baseLabel ?? "(no label)"}`);
	out.push(
		'NOTICE: Resolve each via `write({ path: "conflict://<N>", content })`; the tool replaces the whole conflict region. Use `@ours` / `@theirs` / `@base` / `@both` as content shorthand for the recorded sections (alone or mixed line-by-line).',
	);

	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		out.push("");
		out.push(`──── #${entry.id}  ${range} ────`);

		const baseEqualsOurs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.oursLines);
		const baseEqualsTheirs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.theirsLines);
		const theirsEqualsOurs = sectionsEqual(entry.theirsLines, entry.oursLines);

		out.push("<<< ours");
		appendBody(out, entry.oursLines);

		if (entry.baseLines !== undefined) {
			if (baseEqualsOurs) {
				out.push("=== base ≡ ours");
			} else if (baseEqualsTheirs) {
				out.push("=== base ≡ theirs");
			} else {
				out.push("=== base");
				appendBody(out, entry.baseLines);
			}
		}

		if (theirsEqualsOurs) {
			out.push(">>> theirs ≡ ours");
		} else {
			out.push(">>> theirs");
			appendBody(out, entry.theirsLines);
		}
	}
	return out.join("\n");
}

function pickLabel(
	entries: readonly ConflictEntry[],
	get: (e: ConflictEntry) => string | undefined,
): string | undefined {
	for (const e of entries) {
		const label = get(e);
		if (label && label.trim().length > 0) return label;
	}
	return undefined;
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function appendBody(out: string[], section: readonly string[]): void {
	if (section.length === 0) {
		out.push("(empty)");
		return;
	}
	const shown = section.slice(0, PREVIEW_SIDE_LINES);
	for (const line of shown) out.push(line);
	const hidden = section.length - shown.length;
	if (hidden > 0) out.push(`… (${hidden} more line${hidden === 1 ? "" : "s"})`);
}
