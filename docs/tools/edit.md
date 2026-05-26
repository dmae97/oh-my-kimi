# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/hashline.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/coding-agent/src/hashline/grammar.lark` — custom-tool grammar for hashline mode
  - `packages/coding-agent/src/hashline/input.ts` — splits `¶PATH` sections
  - `packages/coding-agent/src/hashline/parser.ts` — parses op-prefixed edits and verbatim payload lines
  - `packages/coding-agent/src/hashline/apply.ts` — validates anchors and applies edits
  - `packages/coding-agent/src/hashline/anchors.ts` — stale-anchor mismatch formatting
  - `packages/coding-agent/src/hashline/recovery.ts` — cache-based stale-anchor recovery
  - `packages/coding-agent/src/hashline/hash.ts` — computes 4-hex file hashes and `LINE:TEXT` display lines shared with `read`/`search`
  - `packages/coding-agent/src/edit/file-read-cache.ts` — per-session read snapshot cache
  - `packages/coding-agent/src/tools/read.ts` — emits anchored lines and records read snapshots
  - `packages/coding-agent/src/tools/search.ts` — records sparse snapshots from matches/context
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — invalidates FS scan caches after writes
  - `packages/coding-agent/src/edit/streaming.ts` — computes in-flight diff previews for the TUI

## Inputs

### Hashline mode (default)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more edit sections. Anchored sections must start with `¶PATH#HASH`; unbound `¶PATH` is allowed only for new-file / `BOF` / `EOF` boundary inserts. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- Section header: `¶PATH#HASH` for anchored edits, `¶PATH` for BOF/EOF-only inserts
- Insert after: `LINE↓[payload]`
- Insert before: `LINE↑[payload]`
- Replace range: `A-B:[payload]`
- Single-line replace sugar: `A:[payload]` means `A-A:[payload]`
- Delete range: `A-B!`
- Single-line delete sugar: `A!` means `A-A!`
- **Payload semantics:** the first payload line is whatever follows the sigil on the op line itself; additional payload lines follow on subsequent lines and append after the inline first line. An empty inline (just the sigil followed by a newline) means the first payload line is empty. So bare `A↑` / `A↓` insert one blank line, and bare `A:` / `A-B:` replace the line/range with one blank line. But `A↓\nfoo` inserts blank-then-`foo`, not just `foo` — for a single-line insert, put `foo` inline as `A↓foo`.
- `!` deletes and forbids payload.
- Read lines like `84:content` are already valid single-line replacements.
- Special anchors: `BOF`, `EOF` (both support inline payload, e.g. `BOF↓export const done = true;`).
- Anchor token: bare line number, for example `41`
- File binding: 4-hex hash in the section header, for example `¶src/a.ts#1a2b`

Anchors come from `read`/`search` output. `read` emits a `¶PATH#HASH` header and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into op lines.

Other edit modes exist (`replace`, `patch`, `apply_patch`) and are selected outside the tool payload by `resolveEditMode()` in `packages/coding-agent/src/utils/edit-mode.ts`. Their schemas are different; this document covers the default hashline mode.

## Outputs
- Single-shot tool result; hashline mode does not use a `resolve` preview/apply handshake.
- `content` contains one text block per call. For a successful single-file edit it is either:
  - `<path>:` plus a compact diff preview from `packages/coding-agent/src/hashline/diff-preview.ts`, or
  - `Updated <path>` / `Created <path>` when no compact preview text is emitted.
- Parse or recovery warnings are appended as:

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
1. `EditTool.execute()` in `packages/coding-agent/src/edit/index.ts` resolves the active mode. Default is `hashline`; `customFormat` exposes `packages/coding-agent/src/hashline/grammar.lark` with `$HFILE_HASH$` / `$HOP_INSERT_BEFORE$` / `$HOP_INSERT_AFTER$` / `$HOP_REPLACE$` / `$HOP_CHARS$` / `$HFILE$` placeholders filled from `packages/coding-agent/src/hashline/hash.ts`.
2. `executeHashlineSingle()` in `packages/coding-agent/src/hashline/execute.ts` splits the raw `input` into `¶PATH#HASH` / `¶PATH` sections with `splitHashlineInputs()`.
3. If multiple sections target the same path, `mergeSamePathSections()` concatenates them before execution so every op still refers to the original file snapshot.
4. Multi-section calls run a preflight pass (`preflightHashlineSection()`): parse ops, enforce plan-mode write rules, load the current file, reject anchor-scoped edits against missing files, reject auto-generated files, apply edits in memory, and fail if the result is a no-op. This prevents partial batches.
5. `parseHashlineWithWarnings()` in `packages/coding-agent/src/hashline/parser.ts` tokenizes the diff body:
   - ignores blank lines and optional `*** Begin Patch`
   - stops at `*** End Patch`
   - stops at `*** Abort` and emits `ABORT_WARNING`
   - turns `↓` / `↑` payload runs (inline plus subsequent lines) into one `insert` edit per payload line
   - turns `A-B:` with payload into inserts before `A`, then deletes for `A-B`
   - turns `A-B!` into one `delete` edit per line in the range; payload is forbidden
6. `executeHashlineSingle()` computes the current file hash before applying anchored edits. If it differs from the section `#HASH`, recovery tries the read/search snapshot cache before any write.
7. `applyHashlineEdits()` validates only line bounds, then applies the already hash-bound line-number edits.
8. Recovery replays the edits against the cached snapshot for the section hash (`packages/coding-agent/src/edit/file-read-cache.ts`), then 3-way merges the result onto current disk content using `Diff.applyPatch(..., { fuzzFactor: 0 })` in `packages/coding-agent/src/hashline/recovery.ts`. On success the edit proceeds with a warning; on failure a `HashlineMismatchError` is surfaced.
9. Before splicing lines, `absorbReplacementBoundaryDuplicates()` normalizes some malformed-but-recoverable ranges:
   - duplicate prefix/suffix lines adjacent to a replacement can be absorbed by widening the delete range
   - pure inserts can auto-drop duplicated leading/trailing payload lines when `edit.hashlineAutoDropPureInsertDuplicates` is enabled
   - all such fixes append warnings
10. `after_anchor` inserts are normalized to `before_anchor` of the next line, or `EOF` if the anchor was the last line.
11. Anchor-targeted edits are bucketed by target line and applied bottom-up so earlier splices do not invalidate later original line numbers. `BOF` and `EOF` inserts are applied after that.
12. The edited text is restored to the original BOM and line ending style with helpers from `packages/coding-agent/src/edit/normalize.ts` and persisted via `serializeEditFileText()` in `packages/coding-agent/src/edit/read-file.ts`.
13. The writethrough callback from `createLspWritethrough()` may format the file and fetch diagnostics. Late diagnostics are queued back into session state as a hidden deferred message by `EditTool.#injectLateDiagnostics()` in `packages/coding-agent/src/edit/index.ts`.
14. `invalidateFsScanAfterWrite()` calls `invalidateFsScanCache(path)` so filesystem-backed tools do not serve stale scan results.
15. The session file-read cache is refreshed with the post-edit file text via `recordContiguous()`, making the just-written content the new recovery base for subsequent stale-anchor merges.
16. The final response is built from a unified diff (`generateDiffString()`), a compact preview, and any accumulated warnings.

## Modes / Variants
- `hashline` — default mode; line-anchored patch language described here (`packages/coding-agent/src/utils/edit-mode.ts`).
- `replace` — exact/fuzzy old/new text replacement (`packages/coding-agent/src/edit/modes/replace.ts`).
- `patch` — structured JSON diff-hunk mode (`packages/coding-agent/src/edit/modes/patch.ts`).
- `apply_patch` — freeform Codex-style `*** Begin Patch` envelope, internally expanded into patch-mode entries (`packages/coding-agent/src/edit/modes/apply-patch.ts`).

Hashline op examples (single-line payloads are inline; multi-line payloads continue on subsequent lines):

```text
¶src/a.ts#1a2b
4↓const added = true;
```

```text
¶src/a.ts#1a2b
4↑const addedBefore = true;
```

```text
¶src/a.ts#1a2b
4-6:const replacement = true;
```

```text
¶src/a.ts#1a2b
4-5:const clean = (name || DEF).trim();
return clean.length === 0 ? DEF : clean.toUpperCase();
```

```text
¶src/a.ts#1a2b
4:const clean = (name || DEF).trim();
```

BOF/EOF examples:

```text
¶src/a.ts
BOF↓const HEADER = true;
```

```text
¶src/a.ts
EOF↓export const done = true;
```

Delete / blank examples:

```text
¶src/a.ts#1a2b
4!
```

```text
¶src/a.ts#1a2b
4:
```

```text
¶src/a.ts#1a2b
4-6!
```

Multi-file example:

```text
¶src/a.ts#1a2b
4:const enabled = true;
¶src/b.ts#3c4d
20!
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
- File hashes are 4 lowercase hex chars from `computeFileHash()` in `packages/coding-agent/src/hashline/hash.ts`.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/coding-agent/src/hashline/constants.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` (`HASHLINE_RECOVERY_FUZZ_FACTOR`) in `packages/coding-agent/src/hashline/recovery.ts`.
- The per-session read cache keeps at most 30 paths (`MAX_PATHS_PER_SESSION`) in `packages/coding-agent/src/edit/file-read-cache.ts`.
- Hashline streaming chunk defaults are 200 lines or 64 KiB per chunk (`packages/coding-agent/src/hashline/types.ts`, consumed by `packages/coding-agent/src/hashline/stream.ts`).
- `HL_OP_INSERT_BEFORE` is `↑`, `HL_OP_INSERT_AFTER` is `↓`, `HL_OP_REPLACE` is `:`, `HL_OP_DELETE` is `!`, `HL_OP_CHARS` is `↑↓:!`, `HL_FILE_PREFIX` is `¶`, `HL_FILE_HASH_SEP` is `#`, and `HL_LINE_BODY_SEP` is `:` (`packages/coding-agent/src/hashline/hash.ts`).

## Errors
- Missing section header:
  - `input must begin with "¶PATH#HASH" on the first non-blank line for anchored edits; got: ...`
- Empty header:
  - `Input header "¶" is empty; provide a file path.`
- Missing hash for anchored edit:
  - `Missing hashline file hash for anchored edit to <path>; use ¶<path>#hash from your latest read.`
- Line-hash anchors in edit ops:
  - `line N: edit ops use bare line numbers. Copy the ¶PATH#hash header, then use anchors like 42, 42-45, BOF, or EOF.`
- Bad anchor token:
  - `line N: expected a line number such as "119"; got "...".`
- Bad range syntax:
  - `line N: range must be LINE or LINE-LINE (one dash, no spaces); got ...`
  - `line N: range A-B ends before it starts.`
- Payload forbidden for `!`:
  - `line N: ! deletes only. Payload is forbidden after !; use : to replace.`
- Stray payload line:
  - `line N: payload line has no preceding ↑, ↓, :, or ! operation.`
- Unknown op:
  - `line N: unrecognized op. Use LINE↑ (insert before), LINE↓ (insert after), LINE: / A-B: (replace), or LINE! / A-B! (delete).`
- Missing file for anchor-scoped edits:
  - `File not found: <path>`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale file hash throws `HashlineMismatchError`. The error contains both hashes, re-read guidance, and nearby current file lines as `*LINE:TEXT` / ` LINE:TEXT`.
- No-op edit:
  - `Edits to <path> resulted in no changes being made.`
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Notes
- `read` and `search` are the authoritative source of section hashes. Copy `¶PATH#HASH`; op lines use bare line numbers and do not want the trailing `:TEXT`.
- Multi-op patches are parsed against the original file snapshot. Do not renumber later anchors after earlier ops; `applyHashlineEdits()` buckets and applies them bottom-up.
- Failed hand-edits often come from sequentially shifting later anchors inside the same patch. Treat every op as using the line numbers from the original section header.
- `A-B:` is not a primitive replace in the parser. With payload, it expands to inserts before `A` plus deletes for `A-B`. `A-B!` is the direct delete form. Bare `A:` / `A-B:` (no payload) replaces with a single blank line; bare `↑` / `↓` insert a blank line.
- Inline payload tip: trailing whitespace on the op line is trimmed. To preserve trailing spaces in the inserted/replacement content, put that content on the next line instead of inline.
- `computeFileHash()` normalizes CR characters and trailing whitespace before hashing. The section survives line-ending and trailing-space-only changes, but not substantive file edits.
- `splitHashlineInputs()` normalizes absolute `¶PATH#HASH` headers back to a cwd-relative path when the file is inside the current working tree. Headers with any run of leading `¶` chars (e.g. `¶foo.ts`, `¶¶foo.ts`, `¶¶¶foo.ts`) are accepted; the canonical form is `¶PATH#HASH` for anchored edits.
- Optional `*** Begin Patch` / `*** End Patch` markers are accepted in hashline mode, but the file sections are still `¶PATH#HASH`-based, not Codex `*** Update File:` hunks.
- `*** Abort` terminates parsing early and returns `ABORT_WARNING`; ops parsed before the marker still apply.
- File-read cache invalidation is conflict-based, not write-through invalidation. If `read` later records content for a line that disagrees with the cached snapshot, the entire snapshot for that path is replaced with the newly observed lines (`packages/coding-agent/src/edit/file-read-cache.ts`).
- There is no resolve-style apply/discard phase for hashline edits. The only preview path is the transient TUI diff preview in `packages/coding-agent/src/edit/streaming.ts`.
