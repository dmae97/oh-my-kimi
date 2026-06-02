/**
 * Pure data types shared across the hashline parser, applier, and patcher.
 * Nothing in this file references a filesystem, agent runtime, or schema
 * library — keep it that way.
 */

/** A line-number anchor (1-indexed). */
export interface Anchor {
	line: number;
}

/** Where an `insert` edit should land relative to existing content. */
export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

/**
 * A single low-level edit produced by the parser and consumed by the applier.
 * Multi-line replacements decompose to one `insert` per replacement line plus
 * one `delete` per consumed line. Replacement payloads are tagged so the
 * applier can distinguish literal insertion from new content for a deleted
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
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string }
	| {
			/**
			 * Deferred block edit (`replace block N:` / `delete block N`). The exact
			 * line span is unknown at parse time — it is computed by
			 * {@link resolveBlockEdits} once file text + path (→ language) are
			 * available, then expanded into concrete edits: a non-empty `payloads`
			 * (from `replace block`) becomes the same `replacement` inserts + deletes
			 * that `replace start..end:` produces; an empty `payloads` (from `delete
			 * block`) becomes a pure range deletion. `applyEdits` never sees this
			 * variant.
			 */
			kind: "block";
			anchor: Anchor;
			payloads: string[];
			lineNum: number;
			index: number;
	  };

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

/**
 * Resolved 1-indexed inclusive line span of a `replace block N:` target.
 */
export interface BlockSpan {
	/** First line of the block (1-indexed, inclusive). */
	start: number;
	/** Last line of the block (1-indexed, inclusive). */
	end: number;
}

/** Request handed to a {@link BlockResolver} to resolve one `replace block N:` anchor. */
export interface BlockResolverRequest {
	/** Target file path (used to infer language by extension). */
	path: string;
	/** Full text the block must be resolved against (the snapshot the tag names). */
	text: string;
	/** 1-indexed line the block must begin on. */
	line: number;
}

/**
 * Resolves a `replace block N:` anchor to the line span of the syntactic block
 * that begins on line N. Returns `null` when no block can be resolved
 * (unrecognized language, blank/out-of-range line, no node begins there, or the
 * resolved subtree has a syntax error). Pure seam: the hashline core declares
 * the contract; the host injects a tree-sitter-backed implementation.
 */
export type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null;
