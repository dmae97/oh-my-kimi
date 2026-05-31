# Changelog

## [Unreleased]

## [15.7.4] - 2026-05-31

### Fixed

- Fixed the `darwin-x64` release build failing in `bun build --compile` because the Windows ORT 1.24 preload pulled `onnxruntime-node` into the static graph and there is no `darwin/x64` prebuilt for that line. The preload is now guarded behind a `process.platform === "win32"` literal that Bun dead-code-eliminates on non-Windows targets; macOS/Linux load fastembed's bundled ORT 1.21 binding as before.

## [15.7.3] - 2026-05-31
### Changed

- Changed embedding result normalization to return `Float32Array` vectors so `embed` and `embedQuery` now cache and emit float32 rows
- Changed the embedding provider contract to a single typed `EmbeddingOutput` (`AsyncIterable<number[][]>`) instead of `unknown`, matching fastembed's `embed()`, so `EmbeddingProvider.embed` and the `provider` runtime option stream the embedding matrix as async batches (`async *embed(texts) { yield texts.map(embedOne); }`)
- Changed local model cache directory resolution for `fastembed` to use `getFastembedCacheDir` instead of the hard-coded `~/.hermes/cache/fastembed` path

### Fixed

- Fixed cosine similarity behavior across retrieval, clustering, and caching to consistently handle mismatched vector lengths as zero-padded and ignore non-finite values
- Fixed embedding API requests to retry transient failures with backoff via shared retry logic before returning null
- Fixed compiled `omp` binaries losing local Mnemopi embeddings by keeping `fastembed` and `onnxruntime-node` reachable to Bun's static compiler while preserving lazy runtime loading.

## [15.7.2] - 2026-05-31

### Fixed

- Fixed Windows startup crashes by keeping fastembed's older ONNX Runtime binding lazy until local embeddings are used.
- Fixed a segfault at startup from eagerly loading fastembed: importing the embeddings module pulled in `fastembed`, which eagerly loads the `onnxruntime-node` native addon. The import is now deferred until a local fastembed model is actually initialized, so API-model, disabled-embeddings, and test runtimes never load the native addon.

## [15.6.0] - 2026-05-30

### Added

- Added `llm.extractionPrompt` runtime option to override the fact-extraction prompt template using `{text}` and `{lang}` placeholders
- Added `llm.consolidationPrompt` runtime option to override the consolidation sleep prompt template using `{memories}`, `{source}`, and `{memory_count}` placeholders
- Published `@oh-my-pi/pi-mnemopi` to npm: the local SQLite memory engine is now built, checked, tested, and released through the monorepo CI pipeline alongside the other workspace packages.
- Exported the diagnostic inspector as the `@oh-my-pi/pi-mnemopi/diagnose` subpath for coding-agent memory maintenance commands.
- Added `flushExtractions()` (on `Mnemopi`, `BeamMemory`, and as a module-level export) to drain in-flight background fact extraction; used by tests and graceful shutdown so facts are persisted before the database closes.

### Changed

- Changed fact extraction to prefer a configured runtime LLM completion path before host extraction, with automatic fallback when the configured completion returns no output or fails

### Fixed

- Fixed `rememberBatch(..., { extract: true })` to run background fact extraction for batch uploads (including per-item `extract` flags) so extracted facts are generated and recallable after extraction
- Fixed `extract: true` fact extraction to continue safely when no LLM is configured by turning extraction failures into no-op background tasks
- Fixed configured LLM fact extraction by using temperature 0 so re-ingesting the same text is deterministic and avoids near-duplicate extractions
- Fixed `remember(..., { extract: true })` silently dropping the flag: it now schedules the LLM fact extractor (`extractFactsSafe`) over the stored content and persists the extracted facts so they become recallable. Previously the LLM extractor had no production callers and `extract` was dead.
