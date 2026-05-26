/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/** Optional patch envelope start marker; silently consumed when present. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing when encountered. */
export const END_PATCH_MARKER = "*** End Patch";

/**
 * Recovery sentinel emitted by the agent loop when a contaminated
 * `to=functions.edit` stream is truncated mid-call (see
 * `docs/ERRATA-GPT5-HARMONY.md`). Behaves like `END_PATCH_MARKER` for
 * parsing — terminates the line loop — and additionally surfaces a
 * warning in the tool result so the model knows to re-issue any
 * remaining edits.
 */
export const ABORT_MARKER = "*** Abort";

/** Warning text appended to the tool result when ABORT_MARKER terminates parsing. */
export const ABORT_WARNING =
	"Tool stream truncated mid-call due to detected output corruption. Applied ops above are valid. Re-issue any remaining edits.";

/**
 * Warning text appended when two consecutive `A-B:` ops on the exact same
 * range get coalesced (model painted a before/after pair). The second op
 * wins; the first op's payload is silently discarded.
 */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Detected an identical-range before/after replace pair; kept only the second block's payload. Issue ONE op per range — the payload is the final desired content, never both old and new.";

/**
 * Warning text appended when a single-line replace op like `83: content`
 * arrives while a multi-line replace `A-B:` is still pending and `83` is
 * inside `A-B`. The model used the read-output `LINE:TEXT` format as if it
 * were a payload-continuation line; we strip the `LINE:` prefix and treat
 * `content` as the next payload line, but warn so the model learns the
 * cleaner format on its own.
 */
export const PAYLOAD_LINE_PREFIX_DEMOTED_WARNING =
	"Detected one or more `LINE:TEXT` lines whose anchors fell inside the pending replace range; treated them as payload-continuation lines and stripped the `LINE:` prefix. Inside a multi-line `A-B:` block, payload lines after the first do not need a line-number prefix.";
