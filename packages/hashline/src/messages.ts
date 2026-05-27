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

// `ABORT_MARKER` (`*** Abort`) still terminates parsing — see the `abort`
// token in `tokenizer.ts` — but no longer surfaces a warning to the caller.
// The earlier wording ("Tool stream truncated mid-call due to detected
// output corruption") was always speculative: by the time we observe the
// marker the stream is already gone, the warning could not actually
// describe the cause, and downstream consumers were not differentiating it
// from any other warning anyway.
/**
 * Warning text appended when two consecutive blocks target the exact same
 * concrete range. The second block wins; the first block is discarded.
 */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Detected two identical-range hashline blocks; kept only the second block. Issue ONE block per range — payload is the final desired content, never both old and new.";

/**
 * Warning text appended when a bare anchor block (`A-B:` with no payload)
 * is followed by an overlapping concrete block. The earlier bare block is
 * dropped on the assumption that the model expressed an old/new pair
 * across two anchors; only the second block's payload is applied.
 */
export const REPLACE_PAIR_COALESCED_OVERLAP_WARNING =
	"Detected an overlapping bare hashline block immediately followed by a concrete block; dropped the earlier bare block. Issue ONE block per range — payload is the final desired content, never both old and new.";

/**
 * Warning text appended when bare body rows (no `+` / `^` prefix) follow a
 * concrete anchor and the parser auto-converts them to `+literal` rows
 * because no `+`/`^` row was present in the block. Helps the model learn
 * the canonical body-row syntax while keeping the patch applying.
 */
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Always start payload rows with `+TEXT` (literal) or `^A-B` (repeat) — pasting raw code as payload is not a portable shape.";

/**
 * Warning text appended when a lone `-` body row is retroactively converted
 * to a `:-` delete on the preceding bare anchor. Models occasionally write
 * `A-B:` followed by a `-` row when they meant `A-B:-`.
 */
export const DASH_PAYLOAD_AUTO_DELETE_WARNING =
	"Converted a lone `-` body row to a `:-` delete on the preceding anchor. Write `A-B:-` on the anchor line itself to delete the range.";

/**
 * Warning text appended when a single contiguous run of two or more
 * single-line empty-body blocks (`A-A:` with no payload) is flushed.
 * These commonly indicate the model thought `A-A:` deletes the line; it
 * actually replaces with a blank line. Suggest `A-B:-` instead.
 */
export const STACKED_BLANK_REPLACE_WARNING =
	"Detected a run of single-line empty-body blocks (`A-A:` with no payload). Each one REPLACES its line with a blank; to delete lines use `A-B:-`.";

/**
 * Warning text emitted when a body row begins with `+^A-B` — the model
 * mistakenly prefixed a repeat row with the `+` literal sigil. We reroute
 * the row as a `^A-B` repeat so the patch still applies, then surface this
 * warning so the model sees the mistake on the next turn.
 */
export const PLUS_PREFIXED_REPEAT_WARNING =
	"A body row started with `+^A-B`. `+` (literal text) and `^A-B` (repeat) are sibling row kinds — a row uses exactly one of them. Treated as `^A-B`; remove the leading `+` next time.";

/** Error text prefix emitted when an anchor line carries inline payload. */
export const INLINE_PAYLOAD_REJECTED_PREFIX = "Inline payload on the anchor line is rejected.";

/** Error text emitted when inline delete targets BOF/EOF. */
export const VIRTUAL_REPLACE_REJECTED_MESSAGE =
	"BOF:/EOF: anchors are virtual positions and cannot use `:-`. Use `+TEXT` or `^A-B` body rows to insert at a virtual position.";

/** Error text emitted when `^A` repeat shorthand is used. */
export const REPEAT_SHORTHAND_REJECTED_MESSAGE =
	"Repeat payload shorthand `^A` is rejected. Use explicit `^A-A` for one line.";

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
