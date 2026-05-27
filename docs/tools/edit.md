# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/hashline/src/prompt.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/hashline/src/grammar.lark` — hashline grammar
  - `packages/hashline/src/format.ts` — sigils and header constants (`¶`, `#`, `:`, `:-`, `+`, `^`)
  - `packages/hashline/src/input.ts` — parses `¶PATH#TAG` sections
  - `packages/hashline/src/tokenizer.ts` / `packages/hashline/src/parser.ts` — tokenizes and parses ops
  - `packages/hashline/src/apply.ts` — applies parsed edits to file text
  - `packages/hashline/src/mismatch.ts` — stale-anchor mismatch formatting
  - `packages/hashline/src/recovery.ts` — snapshot-based stale-anchor recovery
  - `packages/hashline/src/snapshots.ts` — mints and resolves per-path two-hex opaque snapshot tags
  - `packages/coding-agent/src/edit/file-snapshot-store.ts` — per-session read/search snapshot store wiring
  - `packages/coding-agent/src/tools/read.ts` — emits anchored lines and records read snapshots
  - `packages/coding-agent/src/tools/search.ts` — records sparse snapshots from matches/context
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — invalidates FS scan caches after writes
  - `packages/coding-agent/src/edit/streaming.ts` — computes in-flight diff previews for the TUI

## Inputs

### Hashline mode (default)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more edit sections. Anchored sections must start with `¶PATH#TAG`; unbound `¶PATH` is allowed only for new-file / `BOF` / `EOF` boundary inserts. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- **Section header**: `¶PATH#TAG` for anchored edits, `¶PATH` for BOF/EOF-only inserts. `TAG` is two lowercase hex chars minted by the session snapshot store.
- **Anchor blocks** select a range of original lines:
  - `A-B:` — select lines A..B; the body rows below describe their new content.
  - `A-B:-` — select lines A..B and delete them. No body permitted.
  - `A:` is accepted as `A-A:`. `A:-` is accepted as `A-A:-`.
  - `BOF:` — virtual position before line 1; body rows insert there.
  - `EOF:` — virtual position after the last line; body rows insert there.
  - `BOF-BOF:` / `EOF-EOF:` / `BOF-EOF:` are silently normalized to the virtual anchor (range suffix carries no information for virtual positions).
- **Body rows** (one per line, immediately under the anchor):
  - `+TEXT` — add the literal line `TEXT` verbatim, including all leading whitespace.
  - `+` alone — add one blank line.
  - `^A-B` — re-emit original file lines A..B. Use this to keep some of the lines you selected. `^A` is accepted as `^A-A`.
- **Semantics of the body**:
  - The new content of the selected range is just the body rows top-to-bottom.
  - `A-B:` with no body rows REPLACES the range with one blank line. Use `A-B:-` to delete.
  - `BOF:` / `EOF:` with no body inserts one blank line at that virtual position.

Anchors come from `read`/`search` output. `read` emits a `¶PATH#TAG` header from the session snapshot store and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into anchor lines.

Other edit modes exist (`replace`, `patch`, `apply_patch`) and are selected outside the tool payload by `resolveEditMode()` in `packages/coding-agent/src/utils/edit-mode.ts`. Their schemas are different; this document covers the default hashline mode.

### Tolerated input shapes (lenient parsing)

Because models reproduce nearby shapes (`read` output, `apply_patch` envelopes, unified-diff hunks), the parser is liberal about a handful of harmless variants:

- `A:` / `A:-` — single-line shorthand for `A-A:` / `A-A:-`.
- `^A` — shorthand for `^A-A`.
- Bare body rows with no `+`/`^` prefix are auto-prepended with `+` and a `BARE_BODY_AUTO_PIPED_WARNING` is appended, BUT only when every row in that block is uniformly bare. Mixed `+`/raw blocks still throw.
- Lone `-` body row immediately after a bare anchor is retroactively converted to a `:-` delete with a `DASH_PAYLOAD_AUTO_DELETE_WARNING`.
- An overlapping bare anchor followed by a concrete delete or replace block is treated as a stale "before then after" pair: the bare block is dropped with a `REPLACE_PAIR_COALESCED_OVERLAP_WARNING`. Identical-range pairs use the same coalesce as a stronger guarantee with `REPLACE_PAIR_COALESCED_WARNING`.
- Two or more consecutive single-line `A-A:` blocks with empty bodies emit a `STACKED_BLANK_REPLACE_WARNING` (the model probably meant `A-B:-`).
- `*`/`>` decoration prefixes from grep-style output are stripped from anchors.
- `*** Update File:` / `*** Add File:` / `*** Delete File:` sentinels and unified-diff `@@` headers throw an `apply_patch sentinel … is not valid in hashline` error so the model knows it shipped the wrong format envelope.
- `-N:` / `-N-M:` apply_patch hunk-anchor prefixes throw an `apply_patch line prefix … is not valid in hashline` error.
- A lone `-` outside any pending block throws a focused `a lone "-" is not a valid hashline op` error pointing at `A-B:-`.
- `*** Begin Patch` / `*** End Patch` envelopes are silently consumed. `*** Abort` terminates parsing silently — ops parsed before the marker still apply, no warning is surfaced.

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
- While the model is still typing arguments, the TUI can compute a diff preview with `packages/coding-agent/src/edit/streaming.ts`; that preview is not a deferred action and does not block execution.

## Flow
1. `EditTool.execute()` in `packages/coding-agent/src/edit/index.ts` resolves the active mode. Default is `hashline`; `customFormat` exposes `packages/hashline/src/grammar.lark` as a constant string for prompt embedding.
2. `executeHashlineSingle()` in `packages/coding-agent/src/edit/hashline/execute.ts` parses the raw `input` via `Patch.parse()` (`packages/hashline/src/input.ts`), which:
   - strips a leading BOM and `*** Begin Patch` markers,
   - splits the input into `¶PATH#TAG` sections,
   - merges multiple sections targeting the same path so every op refers to the original file snapshot,
   - rejects malformed headers.
3. For each section, `Patcher.prepare()` (`packages/hashline/src/patcher.ts`):
   - parses the diff body via `parsePatch()` (tokenizer + parser),
   - reads the current file,
   - resolves the section tag against the session snapshot store,
   - runs recovery if the tag is stale (recorded snapshot replay + 3-way merge against current disk),
   - validates anchor line bounds against the resolved file content,
   - applies the edits in memory via `applyEdits()`.
4. Multi-section calls preflight every section before any write hits the filesystem so a partial batch never lands.
5. `applyEdits()` in `packages/hashline/src/apply.ts`:
   - expands `^A-B` repeat edits into concrete inserts,
   - runs `absorbReplacementBoundaryDuplicates()` to widen replacement deletes when the payload's leading/trailing rows match adjacent file lines (with an `Auto-absorbed …` warning),
   - emits a per-line `Deleted line N contains a structural bracket/brace boundary …` warning ONLY when the block's net brace/paren/bracket balance is not preserved by its replacement payload (so well-formed multi-line replaces no longer false-positive),
   - applies anchor-targeted edits bottom-up so later splices do not invalidate earlier line numbers,
   - applies BOF and EOF inserts after the per-line bucket.
6. `Patcher.commit()` writes the result. The writethrough callback from `createLspWritethrough()` may format the file and fetch diagnostics.
7. `invalidateFsScanAfterWrite()` calls native `invalidateFsScanCache(path)` so filesystem-backed tools do not serve stale scan results.
8. The session file-read cache is refreshed with the post-edit file text via `recordContiguous()`, making the just-written content the new recovery base for subsequent stale-anchor merges.
9. The final response is built from a unified diff (`generateDiffString()`), a compact preview, and any accumulated warnings.

## Modes / Variants
- `hashline` — default mode; line-anchored patch language described here (`packages/coding-agent/src/utils/edit-mode.ts`).
- `replace` — exact/fuzzy old/new text replacement (`packages/coding-agent/src/edit/modes/replace.ts`).
- `patch` — structured JSON diff-hunk mode (`packages/coding-agent/src/edit/modes/patch.ts`).
- `apply_patch` — freeform Codex-style `*** Begin Patch` envelope, internally expanded into patch-mode entries (`packages/coding-agent/src/edit/modes/apply-patch.ts`).

## Worked examples

Reference file (the exact shape `read` returns):

```text
¶a.ts#0a
1:const X = "a";
2:const Y = X;
3:
4:console.log(X);
5:console.log(Y);
6:export { X, Y };
```

Replace line 1 with two lines:

```text
¶a.ts#0a
1-1:
+const X = "b";
+export const Y = X;
```

Insert BELOW line 5 (keep line 5, add after):

```text
¶a.ts#0a
5-5:
^5-5
+console.log(X + Y);
```

Insert ABOVE line 5 (add before, keep line 5):

```text
¶a.ts#0a
5-5:
+console.log(X + Y);
^5-5
```

Delete lines 4..5 entirely:

```text
¶a.ts#0a
4-5:-
```

Replace lines 4..5 with one blank line (NOT a delete):

```text
¶a.ts#0a
4-5:
```

Insert at start and end of file:

```text
¶a.ts#0a
BOF:
+// header
EOF:
+// trailer
```

Multi-file:

```text
¶src/a.ts#0a
4-4:
+const enabled = true;
¶src/b.ts#1f
20-20:-
```

## Side Effects
- Filesystem
  - Reads target files with `readEditFileText()`.
  - Writes full updated file contents with `serializeEditFileText()`.
  - Preserves BOM and original line-ending style.
- Subprocesses / native bindings
  - `createLspWritethrough()` may trigger formatter / diagnostics work through the LSP subsystem.
  - `invalidateFsScanAfterWrite()` calls native `invalidateFsScanCache()` from `@oh-my-pi/pi-natives`.
- Session state
  - Reads and updates the per-session `FileReadCache` used for stale-anchor recovery.
  - Stores pending deferred-diagnostics abort controllers per path inside `EditTool`.
  - Queues late diagnostics back into the session transcript as a hidden custom message.
- Background work / cancellation
  - A new edit to the same path aborts the prior deferred diagnostics fetch for that path (`packages/coding-agent/src/edit/index.ts`).
  - The tool itself is marked `nonAbortable = true` and `concurrency = "exclusive"` in `packages/coding-agent/src/edit/index.ts`.

## Limits & Caps
- Default mode is `hashline` (`DEFAULT_EDIT_MODE`) in `packages/coding-agent/src/utils/edit-mode.ts`.
- File snapshot tags are exactly two lowercase hex chars minted by the per-session snapshot store.
- Each path gets a 256-slot ring. The initial slot is random, and each store randomizes slot→tag encoding, so tags are opaque rather than predictable counters.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/hashline/src/messages.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` in `packages/hashline/src/recovery.ts`.
- `HL_OP_REPLACE` is `:`, `HL_OP_DELETE_SUFFIX` is `:-`, `HL_PAYLOAD_REPLACE` is `+`, `HL_PAYLOAD_REPEAT` is `^`, `HL_FILE_PREFIX` is `¶`, and `HL_FILE_HASH_SEP` is `#` (`packages/hashline/src/format.ts`).

## Errors
- Missing section header:
  - `input must begin with "¶PATH#HASH" on the first non-blank line for anchored edits; got: ...`
- Empty header:
  - `Input header "¶" is empty; provide a file path.`
- Missing tag for anchored edit:
  - `Missing hashline snapshot tag for anchored edit to <path>; use ¶<path>#tag from your latest read/search output.`
- Inline payload on the anchor line:
  - `line N: Inline payload on the anchor line is rejected. Write the anchor on its own line (e.g. A-B:), then put the body content on the next line prefixed with + (literal) or ^A-B (repeat). …`
- Stray payload line:
  - `line N: payload line has no preceding A-B:, BOF:, or EOF: anchor. Got "...".`
- Raw body row with no `+` / `^` prefix in a mixed-prefix block:
  - `line N: payload row in a hashline block must start with + or ^A-B. Got "...".`
- Range out of order:
  - `line N: range A-B ends before it starts.`
- Overlapping ops on the same anchor:
  - `line N: anchor line X is already targeted by another op on line Y. Issue ONE block per range; payload is only the final desired content, never a before/after pair.`
- BOF/EOF used with `:-`:
  - `line N: BOF:/EOF: anchors are virtual positions and cannot use :-. Use +TEXT or ^A-B body rows to insert at a virtual position.`
- Lone `-` op at top level:
  - `line N: a lone "-" is not a valid hashline op. To delete a range, write A-B:- on the anchor line itself (e.g. 5-7:-).`
- apply_patch / unified-diff contamination:
  - `line N: apply_patch sentinel "***  …" is not valid in hashline. Use ¶PATH#HASH then A-B: / A-B:- / BOF: / EOF: blocks …`
  - `line N: unified-diff hunk header (@@) is not valid in hashline. Use a ¶PATH#HASH header and bare A-B: anchor blocks.`
  - `line N: apply_patch line prefix (-N: / -N-M:) is not valid in hashline. Drop the - prefix; use A-B: (replace) or A-B:- (delete) on the anchor line itself.`
- Missing file for anchor-scoped edits:
  - `File not found: <path>`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale snapshot tag throws `MismatchError`. The error contains re-read guidance and nearby current file lines as `*LINE:TEXT` / ` LINE:TEXT`.
- No-op edit:
  - `Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Warnings
- `Detected two identical-range hashline blocks; kept only the second block. …` (`REPLACE_PAIR_COALESCED_WARNING`)
- `Detected an overlapping bare hashline block immediately followed by a concrete block; dropped the earlier bare block. …` (`REPLACE_PAIR_COALESCED_OVERLAP_WARNING`)
- `Auto-prefixed bare body row(s) with +. Always start payload rows with +TEXT (literal) or ^A-B (repeat) …` (`BARE_BODY_AUTO_PIPED_WARNING`)
- `Converted a lone - body row to a :- delete on the preceding anchor. Write A-B:- on the anchor line itself to delete the range.` (`DASH_PAYLOAD_AUTO_DELETE_WARNING`)
- `Detected a run of single-line empty-body blocks (A-A: with no payload). Each one REPLACES its line with a blank; to delete lines use A-B:-.` (`STACKED_BLANK_REPLACE_WARNING`)
- `Auto-absorbed N duplicate line(s) above replacement (file lines A..B matched the payload's leading lines; widened the deletion to start at file line A instead of C).`
- `Auto-absorbed N duplicate line(s) below replacement …` (symmetric variant)
- `Deleted line N contains a structural bracket/brace boundary ("…"); verify the file is still balanced or use '+replacement' payload to keep the boundary intact.` — only fires when the block's net delimiter balance is not preserved by its replacement.
- Recovery banners: `RECOVERY_EXTERNAL_WARNING`, `RECOVERY_SESSION_CHAIN_WARNING`, `RECOVERY_SESSION_REPLAY_WARNING` (`packages/hashline/src/messages.ts`).

## Notes
- `read` and `search` are the authoritative source of section tags. Copy `¶PATH#TAG`; anchor lines use bare line numbers and do not carry the trailing `:TEXT`.
- Multi-op patches are parsed against the original file snapshot. Do not renumber later anchors after earlier ops; `applyEdits()` buckets and applies them bottom-up.
- Failed hand-edits often come from sequentially shifting later anchors inside the same patch. Treat every op as using the line numbers from the original section header.
- Inline payload on the anchor line is rejected. Put the body content on the next line prefixed with `+` (literal) or `^A-B` (repeat).
- Trailing whitespace on body rows is preserved exactly. To preserve trailing spaces, put them in the `+TEXT` row.
- Section tags are opaque snapshot-store slots, not content hashes. A tag is valid only in the session store that minted it; if the live file no longer matches the recorded snapshot, stale-anchor recovery must prove a safe merge before writing.
- `splitRawSections()` (in `packages/hashline/src/input.ts`) normalizes absolute `¶PATH#TAG` headers back to a cwd-relative path when the file is inside the current working tree. Headers with any run of leading `¶` chars (e.g. `¶foo.ts`, `¶¶foo.ts`) are accepted; the canonical form is `¶PATH#TAG` for anchored edits.
- Optional `*** Begin Patch` / `*** End Patch` markers are accepted, but the file sections are still `¶PATH#TAG`-based, not Codex `*** Update File:` hunks.
- `*** Abort` terminates parsing silently; ops parsed before the marker still apply, but no warning is surfaced.
- Snapshot tags are not invalidated on write-through; a tag remains in its path ring until that slot wraps. If a later read records different content, it mints a new tag while old snapshots remain available for recovery until overwritten.
- There is no resolve-style apply/discard phase for hashline edits. The only preview path is the transient TUI diff preview in `packages/coding-agent/src/edit/streaming.ts`.
