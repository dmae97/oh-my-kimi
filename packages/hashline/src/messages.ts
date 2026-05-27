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
 * Warning text appended when two consecutive `A-B:` ops on the exact same
 * range get coalesced (model painted a before/after pair). The second op wins;
 * the first op's payload is silently discarded.
 */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Detected an identical-range before/after replace pair; kept only the second block's payload. Issue ONE op per range — the payload is the final desired content, never both old and new.";

/**
 * Warning text appended when un-prefixed continuation lines are accepted as
 * implicit payload (lenient legacy behavior). The author wrote a multi-line
 * replace without `+` prefixes; the parser accepted it because the lines did
 * not classify as ops/headers/payloads, but the canonical syntax requires `+`
 * on every continuation line after the op.
 */
export const IMPLICIT_CONTINUATION_WARNING =
	"Accepted continuation line(s) without the `+` prefix as implicit payload. Canonical syntax is `A-B:` followed by `+` on every continuation row; without `+`, lines that look like ops will be parsed as new ops instead of payload. Prefer the explicit form.";

/**
 * Warning text appended when an inner `LINE:TEXT` (or sub-range `A-B:TEXT`)
 * op arrives while an outer `A-B:` replace is still pending and the inner
 * anchor falls inside the outer range. The author used the read-output
 * `LINE:TEXT` format as if it were a payload-continuation line; we strip the
 * `LINE:` prefix and append the body to the pending payload, but warn so the
 * canonical `+`-continuation form remains preferred.
 */
export const PAYLOAD_LINE_PREFIX_DEMOTED_WARNING =
	"Detected one or more `LINE:TEXT` lines whose anchors fell inside a pending replace range; treated them as payload-continuation lines and stripped the `LINE:` prefix. Inside an `A-B:` block, every payload line must be on its own row prefixed with `+` — never reuse the read-output gutter format.";

/**
 * Warning text appended when an op carries an inline payload (`LINE:TEXT`,
 * `LINE↑CONTENT`, `LINE↓CONTENT`). Canonical syntax is the bare op followed
 * by `+`-prefixed payload rows on the next line(s).
 */
export const INLINE_PAYLOAD_ACCEPTED_WARNING =
	"Accepted inline payload on the op line (e.g. `LINE:CONTENT`, `LINE↑CONTENT`). Canonical syntax is the bare op followed by `+`-prefixed payload rows on the next line(s). Prefer the explicit form.";

/** Warning text emitted by `Recovery` when an external write fits a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** Warning text emitted by `Recovery` when a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (the file hash advanced after a prior edit in this session).";

/** Warning text emitted by `Recovery` when the session-chain fast-path was taken. */
export const RECOVERY_SESSION_REPLAY_WARNING =
	"Recovered by replaying your edits onto the current file content — your previous edit in this session changed line(s) you re-targeted with a stale hash. Verify the diff matches your intent before continuing.";
