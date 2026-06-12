# Changelog

## [Unreleased]

## [15.11.4] - 2026-06-12

### Breaking Changes

- Renamed every export to drop the `snapcompact`/`Snapcompact`/`SNAPCOMPACT_` qualifier — the package is meant to be consumed via `import * as snapcompact from "@oh-my-pi/snapcompact"`. Functions: `snapcompactCompact` → `compact`, `renderSnapcompactFrame` → `render`, `snapcompactGeometry` → `geometry`, `normalizeForSnapcompact` → `normalize`, `serializeSnapcompactConversation` → `serializeConversation`, `snapcompactImages` → `images`, `getPreservedSnapcompactArchive` → `getPreservedArchive`, `isSnapcompactShape` → `isShape`, `resolveSnapcompactShape` → `resolveShape`, `createSnapcompactFileOps` → `createFileOps`, `computeSnapcompactFileLists` → `computeFileLists`, `upsertSnapcompactFileOperations` → `upsertFileOperations`. Types: `SnapcompactShape` → `Shape`, `SnapcompactFrame` → `Frame`, `SnapcompactArchive` → `Archive`, `SnapcompactGeometry` → `Geometry`, `SnapcompactOptions` → `Options`, `SnapcompactSerializeOptions` → `SerializeOptions`, `SnapcompactFileOperations` → `FileOperations`, `SnapcompactCompactionDetails`/`Preparation`/`Result` → `CompactionDetails`/`CompactionPreparation`/`CompactionResult`, `SnapcompactConvertToLlm` → `ConvertToLlm`. Constants: `SNAPCOMPACT_X` → `X` (`SHAPES`, `FRAME_SIZE`, `MAX_FRAMES`, `FRAME_TOKEN_ESTIMATE`, `PRESERVE_KEY`, `TOOL_RESULT_MAX_CHARS`, `TOOL_ARG_MAX_CHARS`, `TOOL_CALL_MAX_CHARS`, `TRUNCATE_HEAD_RATIO`, `DIM_ON`, `DIM_OFF`).

### Added

- Added `renderMany()` for paging arbitrary text into snapcompact PNG frames as LLM image blocks, and `frames()` for predicting the frame count without rendering

## [15.11.0] - 2026-06-10

### Breaking Changes

- Changed `renderSnapcompactFrame` output from `png: Uint8Array` to `data: string` base64, requiring consumers to read frame payloads from `frame.data`

### Added

- Added new serialization options `toolResultMaxChars`, `toolArgMaxChars`, `toolCallMaxChars`, `truncateHeadRatio`, and `dimToolResults` to `snapcompactCompact`/`serializeSnapcompactConversation` so callers can tune how tool results and arguments are archived
- Added exported default constants `SNAPCOMPACT_TOOL_RESULT_MAX_CHARS`, `SNAPCOMPACT_TOOL_ARG_MAX_CHARS`, `SNAPCOMPACT_TOOL_CALL_MAX_CHARS`, and `SNAPCOMPACT_TRUNCATE_HEAD_RATIO` for reuse when configuring truncation limits
- Added provider-specific snapcompact frame-shape presets and shape helpers (`SNAPCOMPACT_SHAPES`, `resolveSnapcompactShape`, `isSnapcompactShape`) so callers can consistently select validated image-frame geometry for archive renders
- Added `file-operations.md` and `snapcompact-summary.md` prompts to preserve file-read/write context and frame metadata in the compaction prompt flow
- Added a full `packages/snapcompact/research` experiment and visualization suite for running snapcompact SQuAD studies, provider probes, and activation-style analyses
- Added package-level TypeScript exports and publication config so consumers can import `@oh-my-pi/snapcompact` with typed access to snapcompact APIs
- Published `@oh-my-pi/snapcompact` as the reusable snapcompact compaction package, including bitmap-frame rendering helpers, archive helpers, and the local `snapcompactCompact()` strategy.

### Changed

- Changed truncation in archived tool output to keep both the beginning and end of long text using a configurable head/tail ratio instead of a single hard cut
- Changed tool-result text rendering so archived tool results are shown in dim gray ink by default and the summary prompt notes that dim text is archived tool output
- Changed `RenderedFrame` visible-character accounting so `chars` no longer includes invisible dim-control markers
- Changed the file-operations summary block to a single `<files>` tag: one grouped, prefix-folded directory tree with per-file `(Read)`/`(Write)`/`(RW)` markers, replacing the separate `<read-files>`/`<modified-files>` lists; `upsertSnapcompactFileOperations` takes the cumulative read set to distinguish `(RW)` from blind writes

### Fixed

- Fixed frame rendering at archive chunk boundaries to reopen dim spans when a chunk ends inside a dimmed tool-result segment
- Fixed message serialization to strip user- and assistant-provided dim markers so only renderer-generated dim spans can be applied
