# Changelog

## [Unreleased]

### Changed

- `Snowflake.formatParts` packs the id as a single 64-bit BigInt hex format instead of stitching four 16-bit segments (simpler and ~1.7x faster), and `getTimestamp` extracts via exact double arithmetic instead of a BigInt round-trip. Output is bit-identical.


## [15.10.8] - 2026-06-09
### Removed

- Removed the exported `hookFetch` API, which previously intercepted `globalThis.fetch` via middleware handlers
- Removed `hookFetch` from the package entrypoint, so imports from `@.../utils` no longer provide this fetch interception helper

## [15.10.0] - 2026-06-06

### Changed

- `logger.printTimings()` (the `PI_TIMING` startup tree) now surfaces two previously-invisible regions: a `(before instrumentation)` line for runtime init / uncaptured pre-marker work, and an `(unattributed self)` line for the root span's own untimed work so the gap between visible top-level spans and `Total` is no longer swallowed. `Total` is now labelled `(since first marker)` to make the window explicit. The restored `module-timer.ts` preload can feed module spans into the report: each module records `onLoad` → final top-level marker as `total`, a prepended body marker → final marker as `body/TLA`, and resolved static imports as a bounded dependency tree so the report separates graph wait from actual top-level module work.

## [15.9.2] - 2026-06-05

### Added

- Added `getAuthBrokerSnapshotCachePath()` with `OMP_AUTH_BROKER_SNAPSHOT_CACHE` override support for isolating the encrypted broker snapshot cache.

## [15.9.1] - 2026-06-04

### Fixed

- Hardened `getIndentation` against malformed paths: any filesystem error from the `.editorconfig` probe (e.g. `ENAMETOOLONG` on oversized garbage path segments) is now swallowed and cached as a miss instead of escaping and crashing the TUI mid-render ([#1871](https://github.com/can1357/oh-my-pi/issues/1871)).
- Fixed `getIndentation` (and the edit renderer's `replaceTabs` callers) crashing with `ENAMETOOLONG`/`ENOTDIR`/etc. when handed a path with an overlong component or a non-directory in its parent chain. Editorconfig discovery now short-circuits to the default tab width on any path component above `NAME_MAX` (255 bytes) and absorbs any `FsError` while walking the editorconfig chain — best-effort discovery must never escape as an uncaught exception ([#1872](https://github.com/can1357/oh-my-pi/issues/1872)).

## [15.9.0] - 2026-06-04

### Added

- Added color helpers `colorLuma` (perceptual luma), `relativeLuminance` (WCAG, linearized sRGB), and `hslToHex` to the color utilities. The luminance helpers parse `#rgb`/`#rrggbb` hex and 256-color palette indices, returning `undefined` for unparseable values.
- Added `peekFileEnds`, a single-open head-and-tail file peek helper that reuses the head bytes for the tail when the file fits the head window.

- Added `peekFileTail`, the tail mirror of `peekFile`: reads up to the last `maxBytes` of a file ending at EOF, reusing the same pooled-buffer strategy (no per-call allocation for small reads).

## [15.7.3] - 2026-05-31

### Added

- Added `getFastembedCacheDir` to return the FastEmbed model cache directory under ~/.omp/cache/fastembed

### Fixed

- Fixed `$flag` environment parsing to accept lowercase truthy values such as `y`, `true`, `yes`, and `on`

## [15.6.0] - 2026-05-30

### Added

- Added an XDG-aware tiny-title model cache directory helper for coding-agent local title models.