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

/**
 * Warning text appended when two consecutive hunks target the exact same
 * concrete range. The second hunk wins; the first is discarded.
 */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Detected two identical-range hashline hunks; kept only the second hunk. Issue ONE hunk per range — payload is the final desired content, never both old and new.";

/**
 * Warning text appended when a bare hunk header (`A B` with no body)
 * is followed by an overlapping concrete hunk. The earlier bare hunk is
 * dropped on the assumption that the model expressed an old/new pair across
 * two hunks; only the second hunk's payload is applied.
 */
export const REPLACE_PAIR_COALESCED_OVERLAP_WARNING =
	"Detected an overlapping bare hashline hunk immediately followed by a concrete hunk; dropped the earlier bare hunk. Issue ONE hunk per range — payload is the final desired content, never both old and new.";

/**
 * Warning text appended when bare body rows (no `+` / `&` prefix) follow a
 * hunk header and the parser auto-converts them to `+literal` rows because
 * no `+`/`&` row was present in the hunk. Helps the model learn the
 * canonical body-row syntax while keeping the patch applying.
 */
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Always start payload rows with `+TEXT` (literal) or `&A..B` (repeat) — pasting raw code as payload is not a portable shape.";

/**
 * Warning text emitted when a body row begins with `+&A..B` — the model
 * mistakenly prefixed a repeat row with the `+` literal sigil. We reroute
 * the row as a `&A..B` repeat so the patch still applies, then surface this
 * warning so the model sees the mistake on the next turn.
 */
export const PLUS_PREFIXED_REPEAT_WARNING =
	"A body row started with `+&A..B`. `+` (literal text) and `&A..B` (repeat) are sibling row kinds — a row uses exactly one of them. Treated as `&A..B`; remove the leading `+` next time.";

/**
 * Warning text emitted when a hunk body contains unified-diff-style rows
 * (`-old`, ` context`) and the parser silently converts them: `-` rows are
 * dropped (the hunk header's range already deletes those lines), and the
 * leading metadata-space on context rows is stripped once unified-diff
 * mode is detected. Bare body rows are auto-prefixed with `+` regardless.
 */
export const UNIFIED_DIFF_BODY_AUTO_CONVERT_WARNING =
	"Hunk body contained unified-diff-style rows (`-old`, ` context`). The `-` rows were dropped (the hunk header's range already deletes those lines); context rows were treated as `+TEXT` literals. Use `+TEXT` (literal) or `&A..B` (repeat) directly next time.";

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
