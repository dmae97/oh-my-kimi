/**
 * Centralized error and warning text emitted by the hashline parser, applier,
 * and patcher. Consolidating these as named constants makes them easy to
 * audit and keeps wording stable across the rendering paths that surface
 * them.
 */

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

/** Error text emitted when a delete hunk receives a body row. */
export const DELETE_TAKES_NO_BODY = "`delete N..M` does not take body rows. Remove the body, or use `replace N..M:`.";

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
