// Pure planning/presentation seam for the search tool (U1).
//
// Runtime-import-free and I/O-free. The host validates a raw request with
// planSearch, runs the search itself, then renders host-supplied matches and
// digest facts with presentSearch. Both functions are total (no-throw); every
// returned value is deeply frozen.

// Machine-readable validation failure codes emitted by planSearch.
export type SearchIssueCode =
	| "not_record"
	| "missing"
	| "not_string"
	| "empty"
	| "invalid_regex"
	| "not_boolean"
	| "not_integer"
	| "out_of_range";

// Field a SearchIssue refers to; `input` means the request itself.
export type SearchIssueField = "input" | "pattern" | "path" | "glob" | "ignoreCase" | "literal" | "context" | "limit";

// One typed validation failure produced by planSearch.
export interface SearchIssue {
	readonly field: SearchIssueField;
	readonly code: SearchIssueCode;
	readonly message: string;
}

// Validated, defaulted search request (OMK grep query/scope shape).
export interface SearchPlan {
	// Pattern bytes verbatim; compiled as a RegExp only when `literal` is false.
	readonly pattern: string;
	// Search scope; defaults to SEARCH_DEFAULT_PATH.
	readonly path: string;
	// Optional file filter glob, bytes preserved verbatim.
	readonly glob?: string;
	readonly ignoreCase: boolean;
	// Treat `pattern` as a literal string instead of a regex.
	readonly literal: boolean;
	// Context lines around each match (host-applied).
	readonly context: number;
	// Global cap on presented matches.
	readonly limit: number;
}

// Result of planSearch: a plan, or at least one typed issue.
export type SearchPlanResult =
	| { readonly ok: true; readonly plan: SearchPlan }
	| { readonly ok: false; readonly issues: readonly [SearchIssue, ...SearchIssue[]] };

// One host-supplied match; `column` is 1-based when known.
export interface SearchHostMatch {
	readonly file: string;
	readonly line: number;
	readonly column?: number;
	readonly text: string;
	// Host digest fact for this line; blank values are treated as absent.
	readonly expectedLineHash?: string;
}

// Host-computed whole-source digest fact for one file path.
export interface SearchSourceDigest {
	readonly path: string;
	readonly digest: string;
}

// One presented match preserving column and line-digest facts.
export interface SearchMatchRecord {
	readonly line: number;
	readonly column?: number;
	readonly text: string;
	readonly expectedLineHash?: string;
}

// All presented matches for one file, ordered by ascending line.
export interface SearchGroup {
	readonly file: string;
	// Host source digest for this file, when supplied.
	readonly digest: string | undefined;
	readonly matches: readonly SearchMatchRecord[];
}

// Contradictory duplicate host digest facts.
export type SearchConflict =
	| {
			readonly kind: "source_digest";
			readonly path: string;
			// Distinct disagreeing digests in first-seen order.
			readonly digests: readonly [string, string, ...string[]];
	  }
	| {
			readonly kind: "line_hash";
			readonly file: string;
			readonly line: number;
			// Distinct disagreeing line hashes in first-seen order.
			readonly hashes: readonly [string, string, ...string[]];
	  };

// Deterministic grouped presentation of one search.
export interface SearchPresentation {
	// File groups, lexicographically ordered by file path.
	readonly groups: readonly SearchGroup[];
	// Distinct files matched, before the global limit.
	readonly totalFiles: number;
	// Merged matches across all files, before the global limit.
	readonly totalMatches: number;
	// Matches cut by the global `plan.limit`.
	readonly omittedMatches: number;
	readonly truncated: boolean;
	// Rendered block: `[PATH#sha256:<digest>]` / `PATH` headers, `N@sha256:<digest>|TEXT` / `N|TEXT` lines.
	readonly text: string;
}

// Result of presentSearch: a presentation, or host digest conflicts.
export type SearchPresentResult =
	| { readonly ok: true; readonly presentation: SearchPresentation }
	| { readonly ok: false; readonly conflicts: readonly [SearchConflict, ...SearchConflict[]] };

// Default search scope when the request omits `path`.
export const SEARCH_DEFAULT_PATH = ".";
// Default context lines when the request omits `context`.
export const SEARCH_DEFAULT_CONTEXT = 0;
// Default global cap on presented matches.
export const SEARCH_DEFAULT_LIMIT = 100;

function deepFreezeValue(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreezeValue(child);
}

function deepFreeze<T extends object>(value: T): T {
	deepFreezeValue(value);
	return value;
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchIssue(field: SearchIssueField, code: SearchIssueCode, message: string): SearchIssue {
	return { field, code, message };
}

function compilesAsRegExp(source: string): boolean {
	try {
		return typeof RegExp(source).source === "string";
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

function nonBlankStringField(record: Raw, field: "path" | "glob", issues: SearchIssue[]): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") issues.push(searchIssue(field, "not_string", `${field} must be a string`));
	else if (value.trim().length === 0) issues.push(searchIssue(field, "empty", `${field} must not be blank`));
	else return value;
	return undefined;
}

function booleanField(record: Raw, field: "ignoreCase" | "literal", issues: SearchIssue[]): boolean {
	const value = record[field];
	if (value === undefined || typeof value === "boolean") return value === true;
	issues.push(searchIssue(field, "not_boolean", `${field} must be a boolean`));
	return false;
}

function safeIntegerField(
	record: Raw,
	field: "context" | "limit",
	min: number,
	fallback: number,
	issues: SearchIssue[],
): number {
	const value = record[field];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		issues.push(searchIssue(field, "not_integer", `${field} must be a safe integer`));
		return fallback;
	}
	if (value < min) {
		issues.push(searchIssue(field, "out_of_range", `${field} must be >= ${min}`));
		return fallback;
	}
	return value;
}

// Never throws; issues are collected in field order (`pattern`, `path`,
// `glob`, `ignoreCase`, `literal`, `context`, `limit`). Nonblank
// pattern/path/glob bytes are preserved verbatim; the pattern must compile as
// a RegExp only when `literal` is false.
/** Validate a raw search request into a {@link SearchPlan}; total, no-throw. */
export function planSearch(input: unknown): SearchPlanResult {
	if (!isRecord(input)) {
		return deepFreeze({
			ok: false,
			issues: [searchIssue("input", "not_record", "search request must be a plain object")],
		});
	}
	const issues: SearchIssue[] = [];
	const rawLiteral = input.literal;
	const literal = typeof rawLiteral === "boolean" ? rawLiteral : false;
	const rawPattern = input.pattern;
	let pattern = "";
	if (rawPattern === undefined) issues.push(searchIssue("pattern", "missing", "pattern is required"));
	else if (typeof rawPattern !== "string")
		issues.push(searchIssue("pattern", "not_string", "pattern must be a string"));
	else if (rawPattern.trim().length === 0) issues.push(searchIssue("pattern", "empty", "pattern must not be blank"));
	else if (!literal && !compilesAsRegExp(rawPattern)) {
		issues.push(searchIssue("pattern", "invalid_regex", "pattern must compile as a RegExp"));
	} else pattern = rawPattern;
	const path = nonBlankStringField(input, "path", issues) ?? SEARCH_DEFAULT_PATH;
	const glob = nonBlankStringField(input, "glob", issues);
	const ignoreCase = booleanField(input, "ignoreCase", issues);
	booleanField(input, "literal", issues);
	const context = safeIntegerField(input, "context", 0, SEARCH_DEFAULT_CONTEXT, issues);
	const limit = safeIntegerField(input, "limit", 1, SEARCH_DEFAULT_LIMIT, issues);
	const [first, ...rest] = issues;
	if (first !== undefined) return deepFreeze({ ok: false, issues: [first, ...rest] });
	const base = { pattern, path, ignoreCase, literal, context, limit };
	return deepFreeze({ ok: true, plan: glob === undefined ? base : { ...base, glob } });
}

type MergedMatch = { column: number | undefined; text: string; hashes: string[] };

// Distinct non-blank values appended in first-seen order.
function appendDistinct(bucket: string[], value: string | undefined): void {
	if (value !== undefined && value.length > 0 && !bucket.includes(value)) bucket.push(value);
}

// Conflict/order policy: duplicate `file`+`line` matches merge (first
// occurrence wins for text and column); disagreeing `expectedLineHash` facts
// or disagreeing duplicate `sourceDigests` entries yield `ok: false` conflicts
// instead of a silent choice. Files are ordered lexicographically, lines
// ascending; the global `plan.limit` cut in that order is reported via
// `omittedMatches`, `truncated`, and a `[+N more matches]` marker.
/** Render host-supplied matches as a deterministic grouped presentation. */
export function presentSearch(
	plan: SearchPlan,
	matches: readonly SearchHostMatch[],
	sourceDigests?: readonly SearchSourceDigest[],
): SearchPresentResult {
	const digestsByPath = new Map<string, string[]>();
	for (const entry of sourceDigests ?? []) {
		const bucket = digestsByPath.get(entry.path);
		if (bucket === undefined) digestsByPath.set(entry.path, entry.digest.length === 0 ? [] : [entry.digest]);
		else appendDistinct(bucket, entry.digest);
	}
	const byFile = new Map<string, Map<number, MergedMatch>>();
	for (const match of matches) {
		const fileBucket = byFile.get(match.file) ?? new Map<number, MergedMatch>();
		if (!byFile.has(match.file)) byFile.set(match.file, fileBucket);
		const merged = fileBucket.get(match.line);
		if (merged === undefined) {
			const hashes: string[] = [];
			appendDistinct(hashes, match.expectedLineHash);
			fileBucket.set(match.line, { column: match.column, text: match.text, hashes });
		} else {
			if (merged.column === undefined && match.column !== undefined) merged.column = match.column;
			appendDistinct(merged.hashes, match.expectedLineHash);
		}
	}
	const conflicts: SearchConflict[] = [];
	for (const path of [...digestsByPath.keys()].sort()) {
		const [head, second, ...rest] = digestsByPath.get(path) ?? [];
		if (head !== undefined && second !== undefined) {
			conflicts.push({ kind: "source_digest", path, digests: [head, second, ...rest] });
		}
	}
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		for (const [line, merged] of [...(byFile.get(file) ?? [])].sort((a, b) => a[0] - b[0])) {
			const [head, second, ...rest] = merged.hashes;
			if (head !== undefined && second !== undefined) {
				conflicts.push({ kind: "line_hash", file, line, hashes: [head, second, ...rest] });
			}
		}
	}
	const [firstConflict, ...restConflicts] = conflicts;
	if (firstConflict !== undefined) return deepFreeze({ ok: false, conflicts: [firstConflict, ...restConflicts] });
	let totalMatches = 0;
	for (const fileBucket of byFile.values()) totalMatches += fileBucket.size;
	const omittedMatches = Math.max(0, totalMatches - plan.limit);
	const truncated = omittedMatches > 0;
	const groups: SearchGroup[] = [];
	const blocks: string[] = [];
	let remaining = totalMatches - omittedMatches;
	for (const file of files) {
		if (remaining === 0) break;
		const ordered = [...(byFile.get(file) ?? [])].sort((a, b) => a[0] - b[0]).slice(0, remaining);
		remaining -= ordered.length;
		const digestBucket = digestsByPath.get(file) ?? [];
		const digest = digestBucket.length === 1 ? digestBucket[0] : undefined;
		const records: SearchMatchRecord[] = [];
		const lines: string[] = [digest === undefined ? file : `[${file}#sha256:${digest}]`];
		for (const [line, merged] of ordered) {
			const [expectedLineHash] = merged.hashes;
			records.push({
				line,
				...(merged.column === undefined ? {} : { column: merged.column }),
				text: merged.text,
				...(expectedLineHash === undefined ? {} : { expectedLineHash }),
			});
			const anchor = expectedLineHash === undefined ? `${line}` : `${line}@sha256:${expectedLineHash}`;
			lines.push(`${anchor}|${merged.text}`);
		}
		groups.push({ file, digest, matches: records });
		blocks.push(lines.join("\n"));
	}
	if (truncated) blocks.push(`[+${omittedMatches} more matches]`);
	const text = blocks.length === 0 ? "[no matches]" : blocks.join("\n\n");
	return deepFreeze({
		ok: true,
		presentation: { groups, totalFiles: files.length, totalMatches, omittedMatches, truncated, text },
	});
}
