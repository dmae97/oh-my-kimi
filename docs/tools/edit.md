# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/hashline/src/prompt.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/hashline/src/grammar.lark` — canonical constrained-decoding grammar
  - `packages/hashline/src/format.ts` — sigils and header constants (`¶`, `#`, `+`, `replace`, `delete`, `insert`)
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
| `input` | `string` | Yes | One or more file sections. Anchored sections start with `¶PATH#TAG`; hashless `¶PATH` is allowed only for new-file creation or purely `insert head:` / `insert tail:` inserts. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- **File header**: `¶PATH#TAG` (or `¶PATH` for new-file / head/tail-only inserts). `TAG` is three uppercase-hex chars minted by the session snapshot store.
- **Operations**:
  - `replace N..M:` — replace original lines N..M with the body rows below.
  - `delete N..M` — delete original lines N..M. No body.
  - `insert before N:` — insert body rows immediately before line N.
  - `insert after N:` — insert body rows immediately after line N.
  - `insert head:` — insert body rows at the start of the file.
  - `insert tail:` — insert body rows at the end of the file.
- **Body rows**:
  - Only body-bearing headers end in `:`.
  - Every body row is `+TEXT`; `+` alone adds a blank line.
  - `delete` never has body rows.
  - There is no repeat row kind. To keep a line, leave it out of every range; split edits into multiple hunks when needed.
  - `-` rows are invalid. Literal text beginning with `-` or `+` must be written as `+-text` / `++text`.

Anchors come from `read`/`search` output. `read` emits a `¶PATH#TAG` header from the session snapshot store and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into hunk headers.

### Tolerated input shapes (lenient parsing)

The canonical grammar is strict, but the hand parser accepts a few non-dangerous variants:

- `replace N:` — accepted as `replace N..N:`.
- `delete N` — accepted as single-line delete.
- Missing trailing colon on `replace` or `insert` — accepted.
- `replace N-M:`, `replace N…M:`, and `replace N M:` — accepted as `replace N..M:`.
- Bare body rows with no `+` prefix are auto-prepended with `+` and a `BARE_BODY_AUTO_PIPED_WARNING` is appended.
- `*** Begin Patch` / `*** End Patch` envelopes are silently consumed. `*** Abort` terminates parsing silently — ops parsed before the marker still apply, no warning surfaced.
- `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` apply_patch sentinels throw an `apply_patch sentinel … is not valid in hashline` error.
- `@@`-bracketed hunk headers are rejected with guidance to write a verb header.
- Bare `N` and bare `N M` / `N..M` headers are rejected with guidance to write `replace` or `delete`.
- `delete N..M:` and any body rows under `delete` are rejected.
- Empty `replace` / `insert` hunks are rejected.
- `-` body rows are rejected with `MINUS_ROW_REJECTED`.

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
replace 1..1:
+const X = "b";
+export const Y = X;
```

Insert below line 5:

```text
¶a.ts#0A3
insert after 5:
+console.log(X + Y);
```

Insert above line 5:

```text
¶a.ts#0A3
insert before 5:
+console.log(X + Y);
```

Delete lines 4..5 entirely:

```text
¶a.ts#0A3
delete 4..5
```

Insert at start and end of file:

```text
¶a.ts#0A3
insert head:
+// header
insert tail:
+// trailer
```

Multi-file:

```text
¶src/a.ts#0A3
replace 4..4:
+const enabled = true;
¶src/b.ts#1F7
delete 20
```

## Limits & Caps
- File snapshot tags are exactly three uppercase-hex chars minted by the per-session snapshot store.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/hashline/src/messages.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` in `packages/hashline/src/recovery.ts`.
- `HL_FILE_PREFIX` is `¶`, `HL_PAYLOAD_REPLACE` is `+`, `HL_RANGE_SEP` is `..`, `HL_FILE_HASH_SEP` is `#`, and hunk keyword constants are `replace` / `delete` / `insert` (`packages/hashline/src/format.ts`).

## Errors
- Missing section header:
  - `input must begin with "¶PATH#HASH" on the first non-blank line for anchored edits; got: ...`
- Missing tag for anchored edit:
  - `Missing hashline snapshot tag for anchored edit to <path>; use ¶<path>#tag from your latest read/search output.`
- Stray payload line:
  - `line N: payload line has no preceding hunk header. Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` above the body. Got "...".`
- Minus row:
  - ``line N: `-` rows are not valid; hashline ranges already name the lines being changed. To insert a literal line starting with `-`, write `+-…`.``
- Empty body-bearing hunk:
  - `line N: \`replace N..M:\` needs at least one \`+TEXT\` body row. To delete lines, use \`delete N..M\`.`
  - `line N: \`insert\` needs at least one \`+TEXT\` body row.`
- Delete with body:
  - `line N: \`delete N..M\` does not take body rows. Remove the body, or use \`replace N..M:\`.`
- Range out of order:
  - `line N: range A..B ends before it starts.`
- Overlapping hunks on the same anchor:
  - `line N: anchor line X is already targeted by another hunk on line Y. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`
- apply_patch / unified-diff contamination:
  - `line N: apply_patch sentinel "*** …" is not valid in hashline. File sections start with \`¶path#HASH\` (no \`Update File:\` / \`Add File:\` keyword). Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` ops.`
  - `line N: unified-diff hunk header (\`@@ -N,M +N,M @@\`) is not valid in hashline. Use \`replace N..M:\`, \`delete N..M\`, or \`insert before|after|head|tail:\` ops.`
  - `line N: \`@@\`-bracketed hunk header "@@ …" is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a verb header such as \`replace N..M:\`.`
  - `line N: hunk headers need a verb. Use \`replace N..N:\` to replace, or \`delete N\` to delete.`
  - `line N: bare range hunk header "N M" is not valid. Hunk headers need a verb: write \`replace N..M:\` or \`delete N..M\`.`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale snapshot tag: the `Patcher` first attempts snapshot-based recovery. When recovery cannot prove a valid result it throws `MismatchError`, which distinguishes recognized-but-drifted hashes from never-recorded hashes. The error includes the current file hash plus context around each anchor.
- No-op edit:
  - `Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Warnings
- `Auto-prefixed bare body row(s) with +. Body rows must be +TEXT literal lines …` (`BARE_BODY_AUTO_PIPED_WARNING`)
- Recovery banners: `RECOVERY_EXTERNAL_WARNING`, `RECOVERY_SESSION_CHAIN_WARNING`, `RECOVERY_SESSION_REPLAY_WARNING` (`packages/hashline/src/messages.ts`).
