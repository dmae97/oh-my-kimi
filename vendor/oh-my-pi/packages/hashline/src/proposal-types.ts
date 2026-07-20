// Type-only declarations for the hashline proposal seam. No runtime code lives here;
// proposal.ts re-exports these with an erased `.js` type-only export.

/** Stable, descriptive parse-failure categories. */
export type HashProposalErrorCode =
	| "encoding" // ill-formed UTF-16 input
	| "too-large" // patch exceeds the byte budget
	| "syntax" // malformed envelope, header, hunk, anchor, or structure
	| "payload" // body line misuse: orphaned, forbidden, or required-but-empty
	| "limit" // resource limit exceeded (sections, hunks, edits, spans, name lengths)
	| "hash-conflict" // the same path or path:line pinned to two different digests
	| "overlap"; // overlapping concrete spans or duplicate block anchors

export type HashProposalError = Readonly<{
	code: HashProposalErrorCode;
	line?: number;
	message: string;
}>;

export type HashProposalParseResult = Readonly<
	{ ok: true; value: HashProposal } | { ok: false; error: HashProposalError }
>;

/** A 1-based target-file line pinned to the sha256 digest of its exact content. */
export type HashAnchor = Readonly<{ line: number; digest: string }>;

/** Expected whole-file digest, keyed by path. */
export type HashProposalFileExpectation = Readonly<{ path: string; digest: string }>;

/** Expected single-line digest, keyed by path and 1-based line. */
export type HashProposalLineExpectation = Readonly<{ path: string; line: number; digest: string }>;

// Edits carry `sourceLine`, the 1-based line of their hunk inside the patch text.
// Same-cursor operations preserve patch order via array position.

/** SWAP — replace the concrete anchor range with `body`; an empty body deletes the range. */
export type HashProposalReplaceEdit = Readonly<{
	kind: "replace";
	sourceLine: number;
	start: HashAnchor;
	end: HashAnchor;
	body: readonly string[];
}>;

/** DEL — delete the concrete anchor range. */
export type HashProposalDeleteEdit = Readonly<{
	kind: "delete";
	sourceLine: number;
	start: HashAnchor;
	end: HashAnchor;
}>;

/** INS.PRE — insert `body` before the anchor line. */
export type HashProposalInsertBeforeEdit = Readonly<{
	kind: "insert-before";
	sourceLine: number;
	anchor: HashAnchor;
	body: readonly string[];
}>;

/** INS.POST — insert `body` after the anchor line. */
export type HashProposalInsertAfterEdit = Readonly<{
	kind: "insert-after";
	sourceLine: number;
	anchor: HashAnchor;
	body: readonly string[];
}>;

/** INS.HEAD — insert `body` at the top of the file. */
export type HashProposalInsertHeadEdit = Readonly<{
	kind: "insert-head";
	sourceLine: number;
	body: readonly string[];
}>;

/** INS.TAIL — insert `body` at the bottom of the file. */
export type HashProposalInsertTailEdit = Readonly<{
	kind: "insert-tail";
	sourceLine: number;
	body: readonly string[];
}>;

/** SWAP.BLK — replace the block starting at the anchor with `body`. */
export type HashProposalReplaceBlockEdit = Readonly<{
	kind: "replace-block";
	sourceLine: number;
	anchor: HashAnchor;
	body: readonly string[];
}>;

/** DEL.BLK — delete the block starting at the anchor. */
export type HashProposalDeleteBlockEdit = Readonly<{
	kind: "delete-block";
	sourceLine: number;
	anchor: HashAnchor;
}>;

/** INS.BLK.POST — insert `body` after the block starting at the anchor. */
export type HashProposalInsertAfterBlockEdit = Readonly<{
	kind: "insert-after-block";
	sourceLine: number;
	anchor: HashAnchor;
	body: readonly string[];
}>;

/** REM — remove the file. Must be the final hunk of its section. */
export type HashProposalRemoveEdit = Readonly<{ kind: "remove"; sourceLine: number }>;

/** MV — move the file to `to`. Must be the final hunk of its section. */
export type HashProposalMoveEdit = Readonly<{ kind: "move"; sourceLine: number; to: string }>;

export type HashProposalEdit =
	| HashProposalReplaceEdit
	| HashProposalDeleteEdit
	| HashProposalInsertBeforeEdit
	| HashProposalInsertAfterEdit
	| HashProposalInsertHeadEdit
	| HashProposalInsertTailEdit
	| HashProposalReplaceBlockEdit
	| HashProposalDeleteBlockEdit
	| HashProposalInsertAfterBlockEdit
	| HashProposalRemoveEdit
	| HashProposalMoveEdit;

export type HashProposalSection = Readonly<{
	path: string;
	digest: string;
	edits: readonly HashProposalEdit[];
}>;

export type HashProposal = Readonly<{
	sections: readonly HashProposalSection[];
	expectedFileHashes: readonly HashProposalFileExpectation[];
	expectedLineHashes: readonly HashProposalLineExpectation[];
}>;
