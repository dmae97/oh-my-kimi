# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]
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