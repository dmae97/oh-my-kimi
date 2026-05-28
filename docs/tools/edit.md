# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/hashline/src/prompt.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/hashline/src/grammar.lark` — hashline grammar
  - `packages/hashline/src/format.ts` — sigils and header constants (`¶`, `#`, `@@`, `+`, `&`, `,`)
  - `packages/hashline/src/input.ts` — parses `¶PATH#TAG` sections
  - `packages/hashline/src/tokenizer.ts` / `packages/hashline/src/parser.ts` — tokenizes and parses ops
  - `packages/hashline/src/apply.ts` — applies parsed edits to file text
  - `packages/hashline/src/mismatch.ts` — stale-anchor mismatch formatting
  - `packages/hashline/src/recovery.ts` — snapshot-based stale-anchor recovery
  - `packages/hashline/src/snapshots.ts` — mints and resolves per-path opaque snapshot tags

## Inputs

### Hashline mode (default)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more file sections. Anchored sections start with `¶PATH#TAG`; hashless `¶PATH` is allowed only for new-file creation or BOF/EOF-only inserts. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- **File header**: `¶PATH#TAG` (or `¶PATH` for new-file / virtual-only hunks). `TAG` is three uppercase-hex chars minted by the session snapshot store.
- **Hunk header**: bare `A B` selects original lines A..B. The range separator is normally whitespace; the parser also silently accepts `A-B`, `A..B`, and `A…B` (unicode ellipsis). Virtual variants `BOF` and `EOF` target positions before line 1 / after the last line. The bare single-line shorthand `A` is accepted as `A A`.
- **Body rows** (one per line, immediately under the hunk header):
  - `+TEXT` — add the literal line `TEXT` verbatim, including all leading whitespace.
  - `+` alone — add one blank line.
  - `&A..B` — re-emit original file lines A..B. Use this to keep some of the lines you selected. `&A` is accepted as `&A..A`.
- **Semantics**:
  - The new content of the selected range is just the body rows top-to-bottom.
  - **Empty body deletes the range entirely.**
  - `BOF` / `EOF` with empty body is a no-op (nothing to insert).

Anchors come from `read`/`search` output. `read` emits a `¶PATH#TAG` header from the session snapshot store and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into hunk headers.

### Tolerated input shapes (lenient parsing)

Because models reproduce nearby shapes (`read` output, `apply_patch` envelopes, unified-diff hunks), the parser is liberal about a handful of harmless variants:

- `A` — accepted as `A A` (single-line shorthand).
- `A-B`, `A..B`, `A…B` — accepted as `A B` (any of hyphen, double-dot, or unicode ellipsis works as a silent separator).
- `&A` — accepted as `&A..A`.
- Bare body rows with no `+`/`&` prefix are auto-prepended with `+` and a `BARE_BODY_AUTO_PIPED_WARNING` is appended, BUT only when every row in that block is uniformly bare. Mixed `+`/raw blocks still throw.
- `+&A..B` rows (model mistakenly prefixed a repeat with `+`) are silently rerouted as `&A..B` repeats with `PLUS_PREFIXED_REPEAT_WARNING`.
- Identical-range hunks in the same patch are coalesced last-wins with `REPLACE_PAIR_COALESCED_WARNING`.
- An overlapping bare hunk followed by a concrete hunk is treated as a stale "before then after" pair; the bare hunk is dropped with `REPLACE_PAIR_COALESCED_OVERLAP_WARNING`.
- `*** Begin Patch` / `*** End Patch` envelopes are silently consumed. `*** Abort` terminates parsing silently — ops parsed before the marker still apply, no warning surfaced.
- `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` apply_patch sentinels throw an `apply_patch sentinel … is not valid in hashline` error.
- `@@`-bracketed hunk headers (whether the apply_patch `@@ context @@` form or the unified-diff `@@ -N,M +N,M @@` shape) are rejected with an explicit "drop the `@@ ... @@` brackets" message — hashline hunks are bare `A B` lines.

## Outputs
- Single-shot tool result; hashline mode does not use a `resolve` preview/apply handshake.
- `content` contains one text block per call. For a successful single-file edit it is either:
  - `<path>:` plus a compact diff preview from `packages/hashline/src/diff-preview.ts`, or
  - `Updated <path>` / `Created <path>` when no compact preview text is emitted.
- Parse, apply, or recovery warnings are appended as:

```text
Warnings:
...
```

- `details` is `EditToolDetails` from `packages/coding-agent/src/edit/renderer.ts`:
  - `diff`: unified diff string
  - `firstChangedLine`: first changed post-edit line
  - `diagnostics`: LSP/format result if available
  - `op`: `"create"` or `"update"` for hashline mode
  - `meta`: output metadata
  - `perFileResults`: present for multi-section input
- Multi-section input returns one aggregated result with combined text and per-file details.

## Worked examples

Reference file (the exact shape `read` returns):

```text
¶a.ts#0A3
1:const X = "a";
2:const Y = X;
3:
4:console.log(X);
5:console.log(Y);
6:export { X, Y };
```

Replace line 1 with two lines:

```text
¶a.ts#0A3
1
+const X = "b";
+export const Y = X;
```

Insert BELOW line 5 (keep line 5, add after):

```text
¶a.ts#0A3
5
&5
+console.log(X + Y);
```

Insert ABOVE line 5 (add before, keep line 5):

```text
¶a.ts#0A3
5
+console.log(X + Y);
&5
```

Delete lines 4..5 entirely:

```text
¶a.ts#0A3
4 5
```

Insert at start and end of file:

```text
¶a.ts#0A3
BOF
+// header
EOF
+// trailer
```

Multi-file:

```text
¶src/a.ts#0A3
4
+const enabled = true;
¶src/b.ts#1F7
20
```

## Limits & Caps
- File snapshot tags are exactly three uppercase-hex chars minted by the per-session snapshot store.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/hashline/src/messages.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` in `packages/hashline/src/recovery.ts`.
- `HL_FILE_PREFIX` is `¶`, `HL_PAYLOAD_REPLACE` is `+`, `HL_PAYLOAD_REPEAT` is `&`, `HL_RANGE_SEP` is `..` (repeat-row bodies only), and `HL_FILE_HASH_SEP` is `#` (`packages/hashline/src/format.ts`). Hunk headers carry no sigil; the range is just two whitespace-separated line numbers.

## Errors
- Missing section header:
  - `input must begin with "¶PATH#HASH" on the first non-blank line for anchored edits; got: ...`
- Missing tag for anchored edit:
  - `Missing hashline snapshot tag for anchored edit to <path>; use ¶<path>#tag from your latest read/search output.`
- Stray payload line:
  - `line N: payload line has no preceding hunk header. Use an \`A B\` (or \`BOF\` / \`EOF\`) line above the body. Got "...".`
- Raw body row with no `+` / `&` prefix in a mixed-prefix block:
  - `line N: payload row in a hashline hunk must start with + or &A..B. Got "...".`
- Range out of order:
  - `line N: range A..B ends before it starts.`
- Overlapping hunks on the same anchor:
  - `line N: anchor line X is already targeted by another hunk on line Y. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`
- apply_patch / unified-diff contamination:
  - `line N: apply_patch sentinel "*** …" is not valid in hashline. File sections start with \`¶path#HASH\` (no \`Update File:\` / \`Add File:\` keyword). Hunks are bare \`A B\` lines with \`+TEXT\` / \`&A..B\` body rows.`
  - `line N: unified-diff hunk header (\`@@ -N,M +N,M @@\`) is not valid in hashline. Hashline hunks are bare \`A B\` lines (or \`BOF\` / \`EOF\` keywords).`
  - `line N: \`@@\`-bracketed hunk header "@@ …" is not valid in hashline. Drop the \`@@ ... @@\` brackets and write the range directly: \`5 7\` (or \`5\` for a single line, \`BOF\` / \`EOF\` for virtual positions).`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale snapshot tag throws `MismatchError`. The error contains re-read guidance and nearby current file lines as `*LINE:TEXT` / ` LINE:TEXT`.
- No-op edit:
  - `Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Warnings
- `Detected two identical-range hashline hunks; kept only the second hunk. …` (`REPLACE_PAIR_COALESCED_WARNING`)
- `Detected an overlapping bare hashline hunk immediately followed by a concrete hunk; dropped the earlier bare hunk. …` (`REPLACE_PAIR_COALESCED_OVERLAP_WARNING`)
- `Auto-prefixed bare body row(s) with +. Always start payload rows with +TEXT (literal) or &A..B (repeat) …` (`BARE_BODY_AUTO_PIPED_WARNING`)
- `A body row started with `+&A..B`. `+` (literal text) and `&A..B` (repeat) are sibling row kinds …` (`PLUS_PREFIXED_REPEAT_WARNING`)
- Recovery banners: `RECOVERY_EXTERNAL_WARNING`, `RECOVERY_SESSION_CHAIN_WARNING`, `RECOVERY_SESSION_REPLAY_WARNING` (`packages/hashline/src/messages.ts`).
