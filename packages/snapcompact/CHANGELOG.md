# Changelog

## [Unreleased]
### Added

- Added provider-specific snapcompact frame-shape presets and shape helpers (`SNAPCOMPACT_SHAPES`, `resolveSnapcompactShape`, `isSnapcompactShape`) so callers can consistently select validated image-frame geometry for archive renders
- Added `file-operations.md` and `snapcompact-summary.md` prompts to preserve file-read/write context and frame metadata in the compaction prompt flow
- Added a full `packages/snapcompact/research` experiment and visualization suite for running snapcompact SQuAD studies, provider probes, and activation-style analyses
- Added package-level TypeScript exports and publication config so consumers can import `@oh-my-pi/snapcompact` with typed access to snapcompact APIs
- Published `@oh-my-pi/snapcompact` as the reusable snapcompact compaction package, including bitmap-frame rendering helpers, archive helpers, and the local `snapcompactCompact()` strategy.
