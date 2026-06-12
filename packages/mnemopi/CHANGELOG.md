# Changelog

## [Unreleased]

## [15.12.0] - 2026-06-12

### Changed

- Moved `fastembed` and `onnxruntime-node` from `dependencies` to optional `peerDependencies` pinned to exact versions. When the peers are absent (bundled CLI, compiled binary, or installs that skip optional peers), the local embedding path `bun install`s the pinned pair into `~/.omp/cache/fastembed-runtime/<version-key>` on first use and loads fastembed from there — restoring local embeddings in bundled distributions and removing ~270MB of eager native downloads from default installs ([#2389](https://github.com/can1357/oh-my-pi/issues/2389))

## [15.11.4] - 2026-06-12

### Added

- Added `configureRecallFeatures()` (exported from the package root, `core`, and `config`) so hosts can enable the polyphonic recall engine and the enhanced recall query cache programmatically. `polyphonicRecallEnabled()`, `enhancedRecallEnabled()`, and `isEnhancedRecallEnabled()` now fall back to these configured defaults, with the `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL` environment variables still taking precedence whenever they are set. ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))

### Fixed

- Fixed the embedding pipeline's silent `catch {}` blocks (`runEmbedding()`, `getLocalModel()`, and the local-model path of `embed()`) swallowing failures with zero diagnostics. These best-effort paths still degrade gracefully (return `null` / skip the write), but now emit structured `logger.debug` entries with the error and per-site context (item count, model name). The `mnemopi.debug` config flag now propagates into the core library via runtime options (`MnemopiOptions.debug` → `ResolvedMnemopiRuntimeOptions.debug`) and escalates these logs to `warn` so they surface at the default log level. ([#2322](https://github.com/can1357/oh-my-pi/issues/2322))

### Changed

- Extraction, embedding, and remote-LLM clients now accept an `ApiKey` (static string or resolver) and resolve it per request through `withAuth`, so 401s force-refresh and rotate credentials via the central auth-retry policy instead of failing with a stale key. Empty-key setups (local/proxy endpoints without `Authorization`) and pinned literal keys behave exactly as before.
- Embedding and remote-LLM 401 errors now throw pi-ai's typed `ProviderHttpError` instead of `Object.assign`-patched `Error`s, keeping the same structural `.status` contract for the auth-retry classifier.
- SHMR consolidation clustering (`core/shmr`) now uses the real embedding provider when one is configured instead of always hashing: `embed()`, the new `embedBatch()`, `clusterBySimilarity()`, `computeHarmonyScore()`, `harmonize()`, and `recallBeliefs()` are now async, batch-embed candidate texts in a single provider call, and reuse precomputed vectors from `memory_embeddings` for episodic candidates. The SHA1 bag-of-words hash remains as the deterministic fallback when no provider is available or embedding fails. ([#2324](https://github.com/can1357/oh-my-pi/issues/2324))

## [15.10.12] - 2026-06-10

### Changed

- Reworked the in-memory fallback vector search to build a normalized exact vector index per query, matching the shape needed for future quantized or TurboVec-style backends without adding a new dependency yet.

## [15.10.11] - 2026-06-10

### Fixed

- Fixed embedding provider detection to match `openrouter` by URL host, so custom embedding endpoints are now recognized correctly instead of being misclassified by substring matching
- Fixed the check for OpenRouter base URLs so only true `openrouter` hosts are treated as non-custom

## [15.10.8] - 2026-06-09

### Added

- Added a `fetch` option to `ExtractionClient` to inject a custom fetch implementation for remote LLM requests
- Added an optional `fetch` option to `extractFacts` to control the transport used for remote extraction calls
- Added support for passing a custom `fetch` implementation through `complete` and `summarizeMemories` via remote LLM options

## [15.9.1] - 2026-06-04

### Breaking Changes

- Changed `Mnemopi.recall()`, `Mnemopi.recallEnhanced()`, `Mnemopi.search()`, `Mnemopi.query()`, the module-level `recall`/`recallEnhanced`/`search`/`query` exports, the `BeamMemory.recall`/`recallEnhanced` methods, the free `recall`/`recallEnhanced` functions in `core/beam/recall`, and `orchestrateRecall` to return `Promise<RecallResult[]>` so the recall pipeline can auto-derive `queryEmbedding` from the query text via `embedQuery`. Callers must `await` recall calls; pass `queryEmbedding: null` to opt out of auto-embedding and stay on FTS-only.
- Changed the MCP entrypoints `handleToolCall`, `callToolJson`, and `handleJsonRpc` in `mcp-server`/`mcp-tools` to async so the recall/shared-recall handlers can await the new `Promise<ToolResult[]>` shape; external MCP transports must `await` these.

### Fixed

- Fixed `memory_embeddings` never being populated by the production `remember`/`rememberBatch`/`updateWorking`/`consolidateToEpisodic` paths; embedding generation is now scheduled as a background task on `beam.pendingExtractions` (mirroring `scheduleFactExtraction`), so configured providers (fastembed, OpenAI-compatible API, custom) actually run and rows land in `memory_embeddings(memory_id, embedding_json, model)`. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `recall()`/`recallEnhanced()` never deriving a query embedding from the query text, which silently degraded every deployment to FTS-only regardless of provider configuration. The recall pipeline now auto-calls `embedQuery(query)` when `options.queryEmbedding` is undefined; pass `null` to keep the old FTS-only behaviour. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `toRecallOptions` dropping `queryEmbedding` between the `Mnemopi` facade and the beam layer, so callers can now explicitly pin or disable the query vector through the public API.
- Fixed `withMemory` (CLI) and `withBeam`/`withSharedBeam` (MCP) closing the SQLite handle before background fact-extraction and embedding tasks finished, so short-lived `mnemopi store`/`mnemopi sleep` and MCP `remember`/`update` paths now drain `flushExtractions` before close instead of silently dropping `memory_embeddings` rows. CLI handlers and MCP `handleRemember`/`handleUpdate`/`handleSleep`/etc. are async as a result. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)
- Fixed the process-wide `embedQuery()` cache in `core/embeddings.ts` keying by query text alone, which let two `Mnemopi` instances in the same process with different providers/models cross-contaminate their `dense_score` rankings. The cache key now includes a WeakMap-assigned provider identity, the resolved model name, and the configured `apiUrl`, so disjoint runtimes never read each other's cached vectors. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)

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
