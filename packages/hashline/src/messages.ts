/**
 * Centralized error and warning text emitted by the hashline parser, applier,
 * and patcher. Consolidating these as named constants makes them easy to
 * audit and keeps wording stable across the rendering paths that surface
 * them.
 */

import { HL_FILE_HASH_SEP, HL_FILE_PREFIX } from "./format";

/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/** Optional patch envelope start marker; silently consumed when present. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing when encountered. */
export const END_PATCH_MARKER = "*** End Patch";

/**
 * Recovery sentinel emitted by an agent loop when a contaminated tool-call
 * stream is truncated mid-call. Behaves like {@link END_PATCH_MARKER} for
 * parsing — terminates the line loop — and does not surface a warning.
 */
export const ABORT_MARKER = "*** Abort";

/** Warning text appended when two consecutive hunks target the exact same concrete range. */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Detected two identical-range hashline hunks; kept only the second hunk. Issue ONE `replace N..M:` hunk per range — payload is the final desired content, never both old and new.";

/** Warning text appended when an empty bodyless hunk is followed by an overlapping concrete hunk. */
export const REPLACE_PAIR_COALESCED_OVERLAP_WARNING =
	"Detected an overlapping bare hashline hunk immediately followed by a concrete hunk; dropped the earlier bare hunk. Issue ONE `replace N..M:` hunk per range — payload is the final desired content, never both old and new.";

/** Warning text appended when bare body rows are auto-converted to literal rows. */
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines; pasting raw code as payload is not a portable shape.";

/** Error text emitted when a hunk body contains a unified-diff-style `-` row. */
export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; hashline ranges already name the lines being changed. To insert a literal line starting with `-`, write `+-…`.";

/** Error text emitted when a replace hunk has no body. */
export const EMPTY_REPLACE = "`replace N..M:` needs at least one `+TEXT` body row. To delete lines, use `delete N..M`.";

/** Error text emitted when a `replace block N:` hunk has no body. */
export const EMPTY_BLOCK =
	"`replace block N:` needs at least one `+TEXT` body row. To delete a block, use `delete N..M` with the block's line range.";

/**
 * Error text emitted when a `replace block N:` anchor cannot be resolved to a
 * syntactic block (unrecognized language, blank/out-of-range line, no node
 * begins on line N such as a lone closing delimiter, or the resolved block has
 * a syntax error). Names the offending line and steers back to an explicit
 * `replace N..M:` range.
 */
export function blockUnresolvedMessage(line: number): string {
	return (
		`\`replace block ${line}:\` could not resolve a syntactic block beginning on line ${line}. ` +
		`The language may be unsupported, the line may be blank or a closing delimiter, or the block may not parse. ` +
		`Use \`replace ${line}..M:\` with the block's explicit end line instead.`
	);
}

/**
 * Error text emitted when a `replace block N:` edit reaches a code path that
 * has no {@link BlockResolver} wired in. Indicates a host-configuration bug
 * rather than authored-input error.
 */
export const BLOCK_RESOLVER_UNAVAILABLE =
	"`replace block N:` is not available here (no tree-sitter block resolver is configured). Use `replace N..M:` with an explicit range.";

/**
 * Internal invariant error: `applyEdits` received an unresolved `replace block
 * N:` edit. Block edits must be expanded by `resolveBlockEdits` before reaching
 * the applier; hitting this is a wiring bug, not authored-input error.
 */
export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved `replace block` edit reached the applier (resolveBlockEdits was not run).";

/** Error text emitted when a delete hunk receives a body row. */
export const DELETE_TAKES_NO_BODY = "`delete N..M` does not take body rows. Remove the body, or use `replace N..M:`.";

/** Error text emitted when a `delete block N` hunk receives a body row. */
export const DELETE_BLOCK_TAKES_NO_BODY =
	"`delete block N` does not take body rows. Remove the body, or use `replace block N:` to replace the block.";

/** Error text emitted when an insert hunk has no body. */
export const EMPTY_INSERT = "`insert` needs at least one `+TEXT` body row.";

/** Warning text emitted by `Recovery` when an external write fits a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** Warning text emitted by `Recovery` when a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (the file hash advanced after a prior edit in this session).";

/**
 * Warning text emitted by `Recovery` when the session-chain replay
 * fast-path was taken. Distinct from {@link RECOVERY_SESSION_CHAIN_WARNING}
 * because replay is the less-certain mode: the structured-patch 3-way
 * merge refused, the anchor-content gate passed, but a coincidental
 * insert+delete pair earlier in the chain could still leave an anchor's
 * line number pointing at a duplicated row. Surface the hedge so the
 * model verifies before continuing.
 */
export const RECOVERY_SESSION_REPLAY_WARNING =
	"Recovered by replaying your edits onto the current file content — your previous edit in this session changed line(s) you re-targeted with a stale hash. Verify the diff matches your intent before continuing.";

/**
 * Warning emitted when an `insert head:` / `insert tail:` edit is applied to an
 * existing file whose snapshot tag is stale (the file drifted since the read).
 * Head/tail insert position is content-independent — "start"/"end" cannot move
 * with drift — so this is non-fatal: the edit applies onto the live content and
 * we surface the drift instead of hard-failing (unlike an anchored mismatch).
 */
export const HEADTAIL_DRIFT_WARNING =
	"Applied an `insert head:`/`insert tail:` edit onto the current file content even though the snapshot tag was stale (the file changed since your read). Head/tail position is content-independent, so the insert was not rejected — but re-read if the drift was unexpected.";

/**
 * Error text emitted when a hashline section omits the mandatory snapshot tag.
 * The tag is REQUIRED on every section, enforced identically by the apply path
 * ({@link Patcher.prepare}) and the preview/diff path, so both surfaces reuse
 * this single builder to stay in lockstep.
 */
export function missingSnapshotTagMessage(sectionPath: string): string {
	return `Missing hashline snapshot tag for edit to ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag\` from your latest read/search output. To create a new file, use the write tool.`;
}
