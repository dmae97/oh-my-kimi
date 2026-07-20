/**
 * Pure planning/presentation seam for the read tool (U1).
 *
 * Runtime-import-free and I/O-free. The host validates a raw request with
 * {@link planRead}, reads the file itself, then renders the host-supplied
 * text and digest facts with {@link presentRead}. Both functions are total
 * (no-throw); every returned value is deeply frozen.
 */

/** Machine-readable validation failure codes emitted by {@link planRead}. */
export type ReadIssueCode = "not_record" | "missing" | "not_string" | "empty" | "not_integer" | "out_of_range";

/** Field a {@link ReadIssue} refers to; `input` means the request itself. */
export type ReadIssueField = "input" | "path" | "offset" | "limit";

/** One typed validation failure produced by {@link planRead}. */
export interface ReadIssue {
	readonly field: ReadIssueField;
	readonly code: ReadIssueCode;
	readonly message: string;
}

/** Validated, defaulted read request produced by {@link planRead}. */
export interface ReadPlan {
	readonly path: string;
	/** 1-based first line to present. */
	readonly offset: number;
	/** Maximum number of lines to present (clamped to {@link READ_MAX_LIMIT}). */
	readonly limit: number;
}

/** Result of {@link planRead}: a plan, or at least one typed issue. */
export type ReadPlanResult =
	| { readonly ok: true; readonly plan: ReadPlan }
	| { readonly ok: false; readonly issues: readonly [ReadIssue, ...ReadIssue[]] };

/** Host-computed digest fact for one 1-based line. */
export interface ReadLineDigest {
	readonly line: number;
	readonly digest: string;
}

/** Host-supplied file content and digest facts for {@link presentRead}. */
export interface ReadHostFile {
	/** Full file text; CRLF/CR are normalized to LF before windowing. */
	readonly text: string;
	/** Whole-source digest; blank values are treated as absent. */
	readonly sourceDigest?: string;
	/** Per-line digest facts; blank digests are treated as absent. */
	readonly lineDigests?: readonly ReadLineDigest[];
}

/** One presented line: number, raw text, and the host line digest if known. */
export interface ReadLineRecord {
	readonly line: number;
	readonly text: string;
	readonly expectedLineHash?: string;
}

/** Line window actually presented, in 1-based inclusive coordinates. */
export interface ReadWindow {
	readonly startLine: number;
	/** Last presented line; `0` when nothing was presented (empty/beyond EOF). */
	readonly endLine: number;
	readonly totalLines: number;
	/** True when lines beyond `endLine` exist but were cut by the limit. */
	readonly truncated: boolean;
}

/** Deterministic presentation of one read. */
export interface ReadPresentation {
	/** `[path#sha256:<digest>]` when the host supplied a source digest. */
	readonly header: string | undefined;
	readonly lines: readonly ReadLineRecord[];
	readonly window: ReadWindow;
	/** Rendered block: header, `N@sha256:<digest>|TEXT` / `N|TEXT` lines, markers. */
	readonly text: string;
}

/** Contradictory duplicate {@link ReadLineDigest} facts for one line. */
export interface ReadDigestConflict {
	readonly line: number;
	/** Distinct disagreeing digests in first-seen order. */
	readonly digests: readonly [string, string, ...string[]];
}

/** Result of {@link presentRead}: a presentation, or host digest conflicts. */
export type ReadPresentResult =
	| { readonly ok: true; readonly presentation: ReadPresentation }
	| { readonly ok: false; readonly conflicts: readonly [ReadDigestConflict, ...ReadDigestConflict[]] };

/** Default first line when the request omits `offset`. */
export const READ_DEFAULT_OFFSET = 1;
/** Default number of presented lines when the request omits `limit`. */
export const READ_DEFAULT_LIMIT = 2000;
/** Hard ceiling for `limit`; larger requests clamp instead of failing. */
export const READ_MAX_LIMIT = 2000;

function deepFreezeValue(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreezeValue(child);
}

function deepFreeze<T extends object>(value: T): T {
	deepFreezeValue(value);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIssue(field: ReadIssueField, code: ReadIssueCode, message: string): ReadIssue {
	return { field, code, message };
}

function positiveIntegerField(
	record: Record<string, unknown>,
	field: "offset" | "limit",
	fallback: number,
	issues: ReadIssue[],
): number {
	const value = record[field];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		issues.push(readIssue(field, "not_integer", `${field} must be a safe integer`));
		return fallback;
	}
	if (value < 1) {
		issues.push(readIssue(field, "out_of_range", `${field} must be >= 1`));
		return fallback;
	}
	return value;
}

/**
 * Validate a raw read request into a {@link ReadPlan}. Never throws; issues
 * are collected in field order (`path`, `offset`, `limit`). Nonblank path
 * bytes are preserved verbatim; missing `offset`/`limit` take the defaults.
 */
export function planRead(input: unknown): ReadPlanResult {
	if (!isRecord(input)) {
		return deepFreeze({
			ok: false,
			issues: [readIssue("input", "not_record", "read request must be a plain object")],
		});
	}
	const issues: ReadIssue[] = [];
	const rawPath = input.path;
	let path = "";
	if (rawPath === undefined) issues.push(readIssue("path", "missing", "path is required"));
	else if (typeof rawPath !== "string") issues.push(readIssue("path", "not_string", "path must be a string"));
	else if (rawPath.trim().length === 0) issues.push(readIssue("path", "empty", "path must not be empty"));
	else path = rawPath;
	const offset = positiveIntegerField(input, "offset", READ_DEFAULT_OFFSET, issues);
	const limit = Math.min(positiveIntegerField(input, "limit", READ_DEFAULT_LIMIT, issues), READ_MAX_LIMIT);
	const [first, ...rest] = issues;
	if (first !== undefined) return deepFreeze({ ok: false, issues: [first, ...rest] });
	return deepFreeze({ ok: true, plan: { path, offset, limit } });
}

function normalizeLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	// A trailing newline terminates the last line; no phantom empty line.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Distinct non-blank digests per line, first-seen order; typed conflicts for disagreements. */
function collectLineDigests(entries: readonly ReadLineDigest[]): {
	byLine: Map<number, string>;
	conflicts: ReadDigestConflict[];
} {
	const distinct = new Map<number, string[]>();
	for (const entry of entries) {
		if (entry.digest.length === 0) continue;
		const bucket = distinct.get(entry.line);
		if (bucket === undefined) distinct.set(entry.line, [entry.digest]);
		else if (!bucket.includes(entry.digest)) bucket.push(entry.digest);
	}
	const byLine = new Map<number, string>();
	const conflicts: ReadDigestConflict[] = [];
	for (const [line, digests] of distinct) {
		const [head, second, ...rest] = digests;
		if (head === undefined) continue;
		if (second === undefined) byLine.set(line, head);
		else conflicts.push({ line, digests: [head, second, ...rest] });
	}
	conflicts.sort((a, b) => a.line - b.line);
	return { byLine, conflicts };
}

/**
 * Render a validated {@link ReadPlan} against host-supplied content and
 * digest facts. Deterministic and total. Duplicate `lineDigests` entries that
 * disagree yield `ok: false` conflicts instead of a silent choice. Windowing:
 * `[+N more lines]` after a limit cut; empty files and beyond-EOF offsets
 * render bracketed status markers instead of content.
 */
export function presentRead(plan: ReadPlan, file: ReadHostFile): ReadPresentResult {
	const { byLine, conflicts } = collectLineDigests(file.lineDigests ?? []);
	const [firstConflict, ...restConflicts] = conflicts;
	if (firstConflict !== undefined) return deepFreeze({ ok: false, conflicts: [firstConflict, ...restConflicts] });
	const allLines = normalizeLines(file.text);
	const totalLines = allLines.length;
	const sourceDigest = file.sourceDigest;
	const header =
		sourceDigest !== undefined && sourceDigest.length > 0 ? `[${plan.path}#sha256:${sourceDigest}]` : undefined;
	const startLine = plan.offset;
	const lines: ReadLineRecord[] = [];
	const body: string[] = [];
	let endLine = 0;
	let truncated = false;
	if (totalLines === 0) {
		body.push("[empty file]");
	} else if (startLine > totalLines) {
		body.push(`[offset ${startLine} beyond end of file (${totalLines} lines)]`);
	} else {
		endLine = Math.min(startLine + plan.limit - 1, totalLines);
		truncated = endLine < totalLines;
		for (let line = startLine; line <= endLine; line++) {
			const text = allLines[line - 1] ?? "";
			const expectedLineHash = byLine.get(line);
			lines.push(expectedLineHash === undefined ? { line, text } : { line, text, expectedLineHash });
			body.push(expectedLineHash === undefined ? `${line}|${text}` : `${line}@sha256:${expectedLineHash}|${text}`);
		}
		if (truncated) body.push(`[+${totalLines - endLine} more lines]`);
	}
	const text = header === undefined ? body.join("\n") : [header, ...body].join("\n");
	return deepFreeze({
		ok: true,
		presentation: { header, lines, window: { startLine, endLine, totalLines, truncated }, text },
	});
}
