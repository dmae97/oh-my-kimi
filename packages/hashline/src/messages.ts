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
 * parsing — terminates the line loop — and additionally surfaces a warning
 * so the caller knows to re-issue any remaining edits.
 */
export const ABORT_MARKER = "*** Abort";

/** Warning text appended to the tool result when {@link ABORT_MARKER} terminates parsing. */
export const ABORT_WARNING =
	"Tool stream truncated mid-call due to detected output corruption. Applied ops above are valid. Re-issue any remaining edits.";

/**
 * Warning text appended when two consecutive blocks target the exact same
 * concrete range. The second block wins; the first block is discarded.
 */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Detected two identical-range hashline blocks; kept only the second block. Issue ONE block per range — payload is the final desired content, never both old and new.";

/** Error text prefix emitted when an anchor line carries inline payload. */
export const INLINE_PAYLOAD_REJECTED_PREFIX = "Inline payload on the anchor line is rejected.";

/** Error text emitted when `|` replacement payload targets BOF/EOF. */
export const VIRTUAL_REPLACE_REJECTED_MESSAGE =
	"BOF:/EOF: anchors are virtual positions and cannot use `|` replacement payload. Use `↑` or `↓` payload lines.";

/** Warning text emitted by `Recovery` when an external write fits a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** Warning text emitted by `Recovery` when a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (the file hash advanced after a prior edit in this session).";

/** Warning text emitted by `Recovery` when the session-chain fast-path was taken. */
export const RECOVERY_SESSION_REPLAY_WARNING =
	"Recovered by replaying your edits onto the current file content — your previous edit in this session changed line(s) you re-targeted with a stale hash. Verify the diff matches your intent before continuing.";
