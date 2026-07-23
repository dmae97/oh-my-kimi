# Hashline source-binding contract (proposal-only)

- **Status:** SPECIFIED (proposal-only; no write path)
- **Date:** 2026-07-22
- **Authority:** OMP migration roadmap “Work allowed now” item 5; does not authorize a write path, E1 extraction, or publication ([ADR-OMP-007](ADR-OMP-007.md) R1)
- **Source identity:** vendor tree `296cfdbb83bbb7db30248864938cd7f456e2b8f5`  
  - `vendor/oh-my-pi/packages/hashline/src/proposal.ts` SHA-256 `124862dfad2587862469b5beb0bf9c05721e8a08692efb0340b0837641053c4d`  
  - `vendor/oh-my-pi/packages/hashline/src/proposal-types.ts` SHA-256 `5349222423957554a5dd86cbb7a5dec9de003bd347a8e87c021ce0e6e015ce69`
- **Loader surface:** `packages/coding-agent/src/core/tools/omp-pure-seams.ts` exposes `parseHashlineProposal`, `hashProposalSource`, `hashProposalLine`

This document freezes the **proposal-only** contract already implemented by the qualified candidate. It is the SSOT for future source-validation write-path design. It does **not** implement or authorize writes.

## 1. Public API

| Export | Role | I/O |
| --- | --- | --- |
| `parseHashlineProposal(untrustedText: string): HashProposalParseResult` | Parse untrusted patch text → frozen proposal or typed error | none |
| `hashProposalSource(text: string): Promise<string>` | Whole-file digest (async WebCrypto) | none |
| `hashProposalLine(text: string): Promise<string>` | Single-line digest (async WebCrypto) | none |

Runtime: `globalThis.crypto.subtle` only. No `fs`, `process`, network, Bun, or ambient authority. Results and nested objects are deep-frozen on success.

## 2. Output shape

```ts
type HashAnchor = Readonly<{ line: number; digest: string }>; // 1-based line, 64-char lowercase hex

type HashProposal = Readonly<{
  sections: readonly HashProposalSection[];
  expectedFileHashes: readonly { path: string; digest: string }[];
  expectedLineHashes: readonly { path: string; line: number; digest: string }[];
}>;

type HashProposalSection = Readonly<{
  path: string;
  digest: string; // expected whole-file digest for this path
  edits: readonly HashProposalEdit[];
}>;

type HashProposalParseResult =
  | Readonly<{ ok: true; value: HashProposal }>
  | Readonly<{ ok: false; error: HashProposalError }>;

type HashProposalErrorCode =
  | "encoding" | "too-large" | "syntax" | "payload"
  | "limit" | "hash-conflict" | "overlap";
```

`HashProposalEdit` kinds (each carries `sourceLine` = 1-based line inside the patch text):

| kind | Patch op | Anchors | body |
| --- | --- | --- | --- |
| `replace` | `SWAP` | `start`..`end` range | optional (`[]` deletes range) |
| `delete` | `DEL` | `start`..`end` range | forbidden |
| `insert-before` | `INS.PRE` | single `anchor` | required non-empty |
| `insert-after` | `INS.POST` | single `anchor` | required non-empty |
| `insert-after-block` | `INS.BLK.POST` | single `anchor` | required non-empty |
| `insert-head` | `INS.HEAD` | none | required non-empty |
| `insert-tail` | `INS.TAIL` | none | required non-empty |
| `replace-block` | `SWAP.BLK` | single `anchor` | required non-empty |
| `delete-block` | `DEL.BLK` | single `anchor` | forbidden |
| `remove` | `REM` | none | must be last hunk of section |
| `move` | `MV <to>` | none | must be last hunk of section |

`expectedFileHashes` is the de-duplicated set of section path→digest pins.  
`expectedLineHashes` is the de-duplicated set of every anchor `(path, line, digest)` collected during parse. These arrays are the **source-binding surface** a future write path must validate before any mutation.

## 3. Hash algorithm

- Algorithm: **SHA-256** via `crypto.subtle.digest("SHA-256", …)`.
- Encoding of digest string: **lowercase hex**, length **64**.
- **Domain separation** (domain string is UTF-8, including a trailing NUL byte, concatenated before the payload bytes):

| Function | Domain prefix (literal) | Payload |
| --- | --- | --- |
| `hashProposalSource` | `hashline:proposal:source:v1\0` | UTF-8 of normalized whole-file text |
| `hashProposalLine` | `hashline:proposal:line:v1\0` | UTF-8 of the single line text |

A future write path **must** recompute digests with these exact domains. Plain SHA-256 of file/line bytes is not compatible.

## 4. Line-ending and Unicode normalization

| Step | `hashProposalSource` | `hashProposalLine` | `parseHashlineProposal` |
| --- | --- | --- | --- |
| Lone UTF-16 surrogates | throw `HashProposalEncodingError` | throw | fail `encoding` |
| Leading BOM (`U+FEFF`) | strip once | n/a | n/a (patch text) |
| Newlines in payload | `\r\n` / bare `\r` → `\n` before hash | **reject** if `\r` or `\n` present | patch text: `\r\n`/`\r` → `\n`, then split on `\n` |
| Trailing empty split line | n/a | n/a | dropped if final element is `""` |

Line hashes bind the **exact line body after window extraction** (no newline characters). Source hashes bind **BOM-stripped, LF-normalized full text**. Callers that hash lines must pass newline-free strings (the `read` seam already does this per window line).

## 5. Wire format (patch text)

```
*** Begin Patch
[path/to/file#sha256:<64hex>]
SWAP 12@sha256:<64hex>.=15@sha256:<64hex>:
+replacement line
DEL 20@sha256:<64hex>.=20@sha256:<64hex>
INS.PRE 30@sha256:<64hex>:
+inserted
*** End Patch
```

- Envelope markers are exact: `*** Begin Patch` / `*** End Patch`.
- File header: `^\[([^#\r\n]*)#sha256:([0-9a-f]{64})\]$` — path non-empty, ≤ 4096 chars; digest lowercase hex only.
- Anchor: `^([1-9]\d*)@sha256:([0-9a-f]{64})$` — 1-based decimal line, no leading zeros.
- Range: `startAnchor.=endAnchor` with `start.line ≤ end.line`.
- Body lines are prefix `+` (the `+` is stripped; remainder is the body line, which may be empty string as a line of body but insert ops still require `body.length ≥ 1`).
- Resource limits (fail `limit` / `too-large`):

| Cap | Value |
| --- | --- |
| Patch UTF-8 bytes | 1 MiB (`1 << 20`) |
| Sections | 256 |
| Hunks (per cumulative drafts) | 10_000 |
| Edit units | 100_000 |
| Concrete span units | 100_000 |
| Path / move-dest length | 4096 |

## 6. Duplicate-anchor and conflict behavior

All checked **at parse time** (no filesystem). Fail-closed:

| Condition | Code | Rule |
| --- | --- | --- |
| Same `path` appears in two headers with different digests | `hash-conflict` | One path → one file digest |
| Same `(path, line)` pinned to two different digests across anchors | `hash-conflict` | One path:line → one line digest |
| Two concrete `replace`/`delete` spans overlap (`start..end` inclusive) | `overlap` | Sorted span edges must be disjoint |
| Two block ops (`replace-block` / `delete-block`) share the same anchor line | `overlap` | Duplicate block anchor rejected |
| File op (`remove`/`move`) not last in section | `syntax` | Must terminate the section |
| Payload after file op / on delete / outside hunk / empty required body | `payload` | Structural body rules |

Identical re-pins of the **same** digest for the same path or path:line are allowed (idempotent). They collapse into one `expected*` entry.

## 7. Mismatch semantics (proposal-only today)

**Current OMK boundary:** parse + hash only. No host code validates `expectedFileHashes` / `expectedLineHashes` against disk, and no write path consumes the proposal ([ADR-OMP-006](ADR-OMP-006.md), [ADR-OMP-008](ADR-OMP-008.md), [ADR-OMP-009](ADR-OMP-009.md)).

**Required semantics for any future source-validation write path** (separate ADR required):

1. **Re-read** each `expectedFileHashes[i].path` through OMK’s existing single serialized mutation/read authority (not the seam).
2. Compute `actual = await hashProposalSource(fileText)` with §3–§4. If `actual !== expected.digest` → **reject entire proposal**, zero writes.
3. For each `expectedLineHashes[j]`, split the same LF-normalized text into lines (1-based). If line missing or `await hashProposalLine(lineText) !== expected.digest` → **reject entire proposal**, zero writes.
4. Only after **all** file and line expectations pass, apply edits in section order through the existing OMK mutation queue. Never dual-run writes. On any apply failure, stop; do not partially commit remaining sections unless a future ADR explicitly defines transactional multi-file semantics.
5. Stale anchors (content changed since `read`) are ordinary mismatches — fail closed, tell the model to re-read.
6. Proposal parse errors (`ok: false`) never reach the write path.

Until that ADR exists, hosts may only:

- emit anchors via `hashProposalSource` / `hashProposalLine` on `read` (already default-on under [ADR-OMP-009](ADR-OMP-009.md));
- parse patches with `parseHashlineProposal` for inspection/tests;
- treat `HashProposal` as **data**, not an edit command.

## 8. Host wiring today

| Surface | Behavior |
| --- | --- |
| `read` (text) | Default-on: presentation lines carry `N@sha256:<digest>\|` plus source digest header ([ADR-OMP-009](ADR-OMP-009.md)) |
| `grep` | Default-on presentation only; no line digests |
| `edit` / mutation queue | **Unchanged** — does not consume hashline proposals |
| Opt-out | `OMK_OMP_SEAMS=0` restores pre-seam byte-identical read/grep |

## 9. Non-goals / still forbidden

- Hashline write path or treating proposals as authoritative edits
- Bun `xxHash32` `format.ts` / legacy `input.ts` path as the binding algorithm (different hash, not this contract)
- Bridges, polyfills, or reimplementation of digests outside the vendored functions
- Publication, release, tags ([ADR-OMP-007](ADR-OMP-007.md) R1)
- Identity drift from vendor tree `296cfdbb…` without full G1/H1 re-qualification

## 10. Drift rule

If `proposal.ts` / `proposal-types.ts` blobs, vendor tree, or loader exports change from the identities in the header, this contract is **stale**. Re-derive from source, refresh SHA-256 pins, and re-run H1 before any write-path ADR.
