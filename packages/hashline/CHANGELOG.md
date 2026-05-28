# Changelog

## [Unreleased]

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