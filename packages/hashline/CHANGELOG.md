# Changelog

## [Unreleased]

### Fixed

- Fixed hashline replacements that accidentally restated unchanged lines above and below the selected range so they no longer duplicate both boundary lines ([#1664](https://github.com/can1357/oh-my-pi/issues/1664)).

## [15.7.0] - 2026-05-31
### Added

- Added `replace block N:` and `delete block N` patch syntax to replace or delete the entire syntactic block that begins on line N using tree-sitter-resolved spans
- Added `BlockResolver` support in `Patcher` and `PatchSection.applyTo`/`applyPartialTo` to wire language-specific block-resolution at apply time
- Added `resolveBlockEdits` and block edit type definitions to the package API for resolving deferred `replace block` / `delete block` edits

## [15.5.13] - 2026-05-29
### Breaking Changes

- Changed hashline section tags from 3-hex to 4-hex content-hash tags, so legacy 3-digit tags are no longer valid
- Changed hashline syntax to verb-based v4: body-bearing ops are `replace N..M:`, `insert before N:`, `insert after N:`, `insert head:`, and `insert tail:`, while bodyless `delete N..M` handles deletion. Removed `>A..B` repeat rows and the old `prepend:` / `append:` virtual insert headers; `-` rows remain rejected with a teaching error.

### Added

- Added `maxPaths` and `maxVersionsPerPath` options to `InMemorySnapshotStore` to bound tracked paths and per-path snapshot history
- Re-introduced balance-validated boundary repair in `applyEdits`. A replacement hunk (`replace N..M:` + body) is normalized so its payload preserves the deleted region's delimiter balance: when the body restates a closing delimiter that survives just outside the range (duplicate `}` / `);` / `]`) the echo is dropped, and when the range deletes a structural closer the body never restates (missing closer) the closer is spared instead of deleted. A repair fires only when one boundary operation drives the per-channel `()` / `[]` / `{}` imbalance to exactly zero while leaving surrounding text byte-identical (single-line ops are limited to pure structural-closer lines), so balance-preserving edits and intentional balanced duplicates are never touched. Bracket counting skips strings, template literals, and comments. Each repair surfaces a `delimiter-balance` warning through `ApplyResult.warnings`.

### Changed

- Changed patch application to accept edits whenever the live file's normalized content hash matches the section tag, even when that anchor was not covered by a stored snapshot

### Removed

- Removed `SnapshotStore.recordContiguous` and `SnapshotStore.recordSparse` in favor of full-file `record(path, fullText)` snapshots

### Fixed

- Fixed hash mismatch rejections caused by CRLF or trailing spaces/tabs by normalizing those characters before computing file-hash tags

## [15.5.12] - 2026-05-29

### Changed

- `InMemorySnapshotStore` now coalesces consecutive same-path reads into one tag whenever their views agree on every shared line. Overlapping or directly abutting range reads extend the existing snapshot's contiguous run in place; reads separated by a gap union into a `SparseSnapshot` spanning both ranges. A disagreeing shared line is treated as "the file changed on disk" and mints a fresh tag, preserving the prior superset-dedup behavior. This stops sequential range reads of an unchanged file (e.g. `:50-100` then `:100-200`, or `:1-100` then `:150-200`) from fragmenting into separate anchors.

## [15.5.11] - 2026-05-29

### Added

- `MismatchError` now distinguishes "hash recognized but file content drifted" from "hash never recorded for this path". The latter (likely fabricated or carried over from a prior session) emits a dedicated `hash #X is not from this session` rejection message with explicit "never invent the tag" guidance. The `MismatchDetails` interface gains an optional `hashRecognized?: boolean` (defaults to `true` for backward compatibility); `MismatchError` exposes it as a readonly field so callers can branch on the cause.

## [15.5.8] - 2026-05-28
### Breaking Changes

- Removed the single-number hunk header shorthand. A hunk header now REQUIRES two line numbers (`A A` for a single line, `A B` for a range); a bare `A` row throws `single-number hunk header "A" is no longer accepted`. The `&A` body-row shorthand for `&A..A` is unchanged.
- Changed hunk header syntax from `A-B:` to `@@ A..B @@` with `@@ A @@` shorthand for single lines
- Changed repeat payload sigil from `^A-B` to `&A..B` with `&A` shorthand for single lines
- Changed range separator from `-` to `..` in all contexts (anchors and repeats)
- Changed empty hunk behavior: concrete ranges now delete (no blank-line insertion); BOF/EOF empty hunks are now no-ops
- Removed `ApplyOptions` parameter from `applyEdits()` and related APIs; auto-absorb behavior is no longer configurable
- Removed diagnostic warnings for auto-absorbed duplicates from `ApplyResult`; warnings now come only from parser, patcher, or recovery
- Removed legacy hashline block syntax `A-B:`, `A-B:-`, and `^A-B` and replaced edits with `@@ A..B @@` hunks using `+` and `&` body rows
- Removed `A:` shorthand syntax; use explicit `A-A:` for single-line anchors
- Removed `↑` and `↓` payload sigils; use `|TEXT` for literal rows and `^A-B` for repeating original lines
- Removed standalone delete rows; use inline `A-B:-` syntax instead
- Removed `after_anchor` cursor kind; all inserts now use `before_anchor` positioning
- Replaced insert-above/insert-below payload sigils with linear body rows: `|TEXT` emits literal text and `^A-B` repeats original file lines inline.
- Replaced standalone delete rows with inline range deletes: use `A-B:-`.
- Changed empty `A-B:`, `BOF:`, and `EOF:` blocks to write one blank line instead of being rejected.

### Added

- Added compatibility parsing for apply_patch-style and unified-diff row noise by stripping path noise and converting context/delete body rows into hashline-compatible operations with warnings
- Added `A-B:-` inline delete syntax for concrete range anchors
- Added `^A-B` repeat payload syntax to emit original file lines inline
- Added support for empty anchor blocks to write one blank line at the anchor position

### Changed

- Changed unified-diff compatibility mode to silently drop `-old` rows and convert context rows to `+TEXT` literals with a warning instead of rejecting them
- Changed `ABORT_MARKER` behavior to terminate parsing without surfacing a warning
- Changed numeric ranges to `A..B` form and accepted `@@ A @@` as shorthand for `@@ A..A @@`
- Changed empty hunk behavior so a concrete empty hunk deletes the selected range and `BOF`/`EOF` empty hunks no longer insert a blank line
- Changed parse behavior for `*** Abort` to stop processing without returning a speculative truncation warning
- Changed payload row format from three sigils (`|`, `↑`, `↓`) to two (`|`, `^`)
- Changed range anchor syntax to require explicit `A-B` form (no single-line shorthand)
- Changed error messages to reference new syntax and remove references to removed sigils

## [15.5.5] - 2026-05-27

### Breaking Changes

- Redesigned hashline syntax around range anchors (`A-B:`, `A:`, `BOF:`, `EOF:`) and per-line payload sigils (`|`, `↑`, `↓`). Old op-line insert syntax and `\` payload continuations are no longer supported.

### Added

- Added `parsePatchStreaming(diff)` and `PatchSection.applyPartialTo(text, options)` for incremental diff previews. Both tolerate a trailing in-flight op (no payload yet, or a per-token parse error mid-stream) instead of throwing or emitting a phantom empty-payload edit.
- Added `Executor.endStreaming()` — sibling of `end()` that drops a pending op with no accumulated payload rather than flushing it.

### Fixed

- Parser now skips markdown-style `# ...` lines when they directly precede a hashline operation, making model-generated explanatory rows in prompt examples non-blocking.

### Removed

- Removed legacy deletion semantics that treated bare `A-B:` as a blank-line replacement; a bare range anchor now deletes the range.

All notable changes to this package will be documented in this file.

## [15.5.4] - 2026-05-27
### Added

- Added a high-level `Patcher` API with all-or-nothing `apply` and staged `prepare`/`commit` flows for multi-file patch updates
- Added pluggable `Filesystem` and `SnapshotStore` abstractions with built-in `NodeFilesystem`, `InMemoryFilesystem`, and `InMemorySnapshotStore` adapters
- Added patch parsing that consumes `¶PATH#HASH` hunk headers, validates section file hashes, and supports optional patch envelope markers
- Added tolerant input handling that strips read/search prefixes and supports optional `cwd`/fallback-path resolution when parsing patch payloads
- Added automatic line-ending and BOM normalization on read, with original encoding shape restored on write
- Added follow-up helpers `buildCompactDiffPreview` and `streamHashLines` for compact diff previews and chunked streaming of numbered lines
- Added stale-file-hash recovery that replays edits against snapshots and merges results onto current file content when direct hash validation fails
- Initial standalone release. Extracted from `@oh-my-pi/pi-coding-agent`.

### Fixed

- Fixed repeated patch application mutating cached `after_anchor` edits between target snapshots
- Fixed multi-section patching to preflight write policies and reject duplicate canonical targets before any section is committed
- Fixed mixed line-ending restoration to preserve the first newline style instead of rewriting ties to LF