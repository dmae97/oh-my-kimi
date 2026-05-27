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
 * Warning text appended when un-prefixed continuation lines are accepted as
 * implicit payload (lenient legacy behavior). The model authored a multi-line
 * replace without `+` prefixes; the parser accepted it because the lines did
 * not classify as ops/headers/payloads, but the canonical syntax requires `+`
 * on every continuation line after the op.
 */
export const IMPLICIT_CONTINUATION_WARNING =
	"Accepted continuation line(s) without the `+` prefix as implicit payload. Canonical syntax is `A-B:` followed by `+` on every continuation row; without `+`, lines that look like ops will be parsed as new ops instead of payload. Prefer the explicit form.";

/**
 * Warning text appended when an inner `LINE:TEXT` (or sub-range `A-B:TEXT`)
 * op arrives while an outer `A-B:` replace is still pending and the inner
 * anchor falls inside the outer range. The model used the read-output
 * `LINE:TEXT` format as if it were a payload-continuation line; we strip the
 * `LINE:` prefix and append the body to the pending payload, but warn so the
 * canonical `+`-continuation form remains preferred.
 */
export const PAYLOAD_LINE_PREFIX_DEMOTED_WARNING =
	"Detected one or more `LINE:TEXT` lines whose anchors fell inside a pending replace range; treated them as payload-continuation lines and stripped the `LINE:` prefix. Inside an `A-B:` block, every payload line must be on its own row prefixed with `+` — never reuse the read-output gutter format.";
/**
 * Warning text appended when an op carries an inline payload (`LINE:TEXT`,
 * `A-B:TEXT`, `LINE↑TEXT`, `LINE↓TEXT`). Canonical syntax is bare op +
 * `+`-prefixed continuation rows; we accept the inline form leniently so the
 * model's first-attempt edit still lands, but warn so the canonical form
 * remains preferred.
 */
export const INLINE_PAYLOAD_ACCEPTED_WARNING =
	"Accepted inline payload on the op line (e.g. `LINE:CONTENT`, `LINE↑CONTENT`). Canonical syntax is the bare op followed by `+`-prefixed payload rows on the next line(s). Prefer the explicit form.";
