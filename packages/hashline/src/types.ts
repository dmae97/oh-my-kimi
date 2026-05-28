/**
 * Pure data types shared across the hashline parser, applier, and patcher.
 * Nothing in this file references a filesystem, agent runtime, or schema
 * library — keep it that way.
 */

/** A line-number anchor (1-indexed). */
export interface Anchor {
	line: number;
}

/** Where an `insert` or `repeat` edit should land relative to existing content. */
export type Cursor = { kind: "bof" } | { kind: "eof" } | { kind: "before_anchor"; anchor: Anchor };

/**
 * A single low-level edit produced by the parser and consumed by the applier.
 * Multi-line replacements decompose to one `insert`/`repeat` per replacement
 * line plus one `delete` per consumed line. Replacement payloads are tagged so
 * the applier can distinguish literal insertion from new content for a deleted
 * line.
 */
export type Edit =
	| {
			kind: "insert";
			cursor: Cursor;
			text: string;
			lineNum: number;
			index: number;
			mode?: "replacement";
	  }
	| {
			kind: "repeat";
			cursor: Cursor;
			range: ParsedRange;
			lineNum: number;
			index: number;
			mode?: "replacement";
	  }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string };

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
	/** Post-edit text body. */
	text: string;
	/** First line number (1-indexed) that changed, or `undefined` for a no-op apply. */
	firstChangedLine?: number;
	/** Diagnostic warnings collected by the parser, patcher, or recovery. */
	warnings?: string[];
}

/** A parsed `[A..B]` line range. */
export interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

/** Optional hints for {@link splitPatchInput}. */
export interface SplitOptions {
	/** Resolves absolute paths inside hashline headers to cwd-relative form. */
	cwd?: string;
	/**
	 * Fallback path used when the input lacks a `¶PATH` header but contains
	 * recognizable hashline operations. Lets streaming previews work before
	 * the model has written the header.
	 */
	path?: string;
}

/** Streaming-formatter knobs for {@link streamHashLines}. */
export interface StreamOptions {
	/** First line number to use when formatting (1-indexed, default 1). */
	startLine?: number;
	/** Maximum formatted lines per yielded chunk (default 200). */
	maxChunkLines?: number;
	/** Maximum UTF-8 bytes per yielded chunk (default 64 KiB). */
	maxChunkBytes?: number;
}

/** Result of {@link buildCompactDiffPreview}. */
export interface CompactDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

/** Optional knobs for {@link buildCompactDiffPreview}. Reserved for future use. */
export interface CompactDiffOptions {
	/** Maximum entries kept on each side of an unchanged-context truncation (default 2). */
	maxUnchangedRun?: number;
}
