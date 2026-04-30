# Natives Text/Search Pipeline

This document maps the `@oh-my-pi/pi-natives` text/search surface (`grep`, `glob`, `text`, `highlight`) from TypeScript wrappers to Rust N-API exports and back to JS result objects.

Terminology follows `docs/natives-architecture.md`:
- **Wrapper**: TS API in `packages/natives/src/*`
- **Rust module layer**: N-API exports in `crates/pi-natives/src/*`
- **Shared scan cache**: `fs_cache`-backed directory-entry cache used by discovery/search flows

## Implementation files

- `packages/natives/src/grep/index.ts`
- `packages/natives/src/grep/types.ts`
- `packages/natives/src/glob/index.ts`
- `packages/natives/src/glob/types.ts`
- `packages/natives/src/text/index.ts`
- `packages/natives/src/text/types.ts`
- `packages/natives/src/highlight/index.ts`
- `packages/natives/src/highlight/types.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/glob_util.rs`
- `crates/pi-natives/src/fs_cache.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/fd.rs`

## JS API ↔ Rust export mapping

| JS wrapper API | Rust export (`#[napi]`, snake_case -> camelCase) | Rust module |
| --- | --- | --- |
| `grep(options, onMatch?)` | `grep` | `grep.rs` |
| `searchContent(content, options)` | `search` | `grep.rs` |
| `hasMatch(content, pattern, options?)` | `hasMatch` | `grep.rs` |
| `fuzzyFind(options)` | `fuzzyFind` | `fd.rs` |
| `glob(options, onMatch?)` | `glob` | `glob.rs` |
| `invalidateFsScanCache(path?)` | `invalidateFsScanCache` | `fs_cache.rs` |
| `wrapTextWithAnsi(text, width)` | `wrapTextWithAnsi` | `text.rs` |
| `truncateToWidth(text, maxWidth, ellipsis, pad)` | `truncateToWidth` | `text.rs` |
| `sliceWithWidth(line, startCol, length, strict?)` | `sliceWithWidth` | `text.rs` |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter)` | `extractSegments` | `text.rs` |
| `sanitizeText(text)` | `sanitizeText` | `text.rs` |
| `visibleWidth(text)` | `visibleWidth` | `text.rs` |
| `highlightCode(code, lang, colors)` | `highlightCode` | `highlight.rs` |
| `supportsLanguage(lang)` | `supportsLanguage` | `highlight.rs` |
| `getSupportedLanguages()` | `getSupportedLanguages` | `highlight.rs` |

## Pipeline overview by subsystem

## 1) Regex search (`grep`, `searchContent`, `hasMatch`)

### Input/options flow

1. TS wrapper forwards options to native:
   - `grep/index.ts` passes `options` mostly unchanged and wraps callback from `(match) => void` to napi threadsafe callback shape `(err, match)`.
   - `searchContent` and `hasMatch` pass string/`Uint8Array` directly.
2. Rust option structs in `grep.rs` deserialize camelCase fields (`ignoreCase`, `maxCount`, `contextBefore`, `contextAfter`, `maxColumns`, `timeoutMs`).
3. `grep` creates `CancelToken` from `timeoutMs` + `AbortSignal` and runs inside `task::blocking("grep", ...)`.

### Execution branches

- **In-memory branch (pure utility)**
  - `search` → `search_sync` → `run_search` on provided content bytes.
  - No filesystem scan, no `fs_cache`.
- **Single-file branch (filesystem-dependent)**
  - `grep_sync` resolves path, checks metadata is file, streams up to `MAX_FILE_BYTES` per file (`4 MiB`) through ripgrep matcher.
- **Directory branch (filesystem-dependent)**
  - Optional cache lookup via `fs_cache::get_or_scan` when `cache: true`.
  - Fresh scan via `fs_cache::force_rescan` when `cache: false`.
  - Optional empty-result recheck when cache age exceeds `empty_recheck_ms()`.
  - Entry filtering: file-only + optional glob filter (`glob_util`) + optional type filter mapping (`js`, `ts`, `rust`, etc.).

### Search/collection semantics

- Regex engine: `grep_regex::RegexMatcherBuilder` with `ignoreCase` and `multiline`.
- Context resolution:
  - `contextBefore/contextAfter` override legacy `context`.
  - Non-content modes zero out context collection.
- Output modes:
  - `content` => one `GrepMatch` per hit.
  - `count` and `filesWithMatches` both map to count-style entries (`lineNumber=0`, `line=""`, `matchCount` set).
- Limits:
  - Global `offset` and `maxCount` applied across files.
  - Parallel path is used only when `maxCount` is unset and `offset == 0`; otherwise sequential path preserves deterministic global offset/limit semantics.

### Result shaping back to JS

- Rust `SearchResult`/`GrepResult` fields map to TS types via N-API object field conversion.
- Counters are clamped to `u32` before crossing N-API.
- Optional booleans are omitted unless true in some paths (`limitReached`).
- Streaming callback receives each shaped `GrepMatch` (content or count entry).

### Failure behavior

- `searchContent` returns `SearchResult.error` for regex/search failures instead of throwing.
- `grep` rejects on hard errors (invalid path, invalid glob/regex, cancellation timeout/abort).
- `hasMatch` returns `Result<bool>` and throws on invalid pattern/UTF-8 decoding errors.
- File open/search errors in multi-file scans are skipped per-file; scan continues.

### Malformed regex handling

`grep.rs` sanitizes braces before regex compile:
- Invalid repetition-like braces are escaped (`{`/`}` -> `\{`/`\}`) when they cannot form `{N}`, `{N,}`, `{N,M}`.
- This prevents common literal-template fragments (for example `${platform}`) from failing as malformed repetition.
- Remaining invalid regex syntax still returns a regex error.

## 2) File discovery (`glob`) and fuzzy path search (`fuzzyFind`)

`glob` and `fuzzyFind` share `fs_cache` scans; matching logic differs.

### `glob` flow

1. TS wrapper (`glob/index.ts`):
   - `path.resolve(options.path)`.
   - Defaults: `pattern="*"`, `hidden=false`, `gitignore=true`, `recursive=true`.
2. Rust `glob` builds `GlobConfig` and compiles pattern via `glob_util::compile_glob`.
3. Entry source:
   - `cache=true` => `get_or_scan` + optional stale-empty `force_rescan`.
   - `cache=false` => `force_rescan(..., store=false)` (fresh only).
4. Filtering:
   - Skip `.git` always.
   - Skip `node_modules` unless requested (`includeNodeModules` or pattern mentioning node_modules).
   - Apply glob match.
   - Apply file-type filter; symlink `file/dir` filters resolve target metadata.
5. Optional sort by mtime desc (`sortByMtime`) before truncating to `maxResults`.

### `fuzzyFind` flow (implemented in `fd.rs`)

1. TS wrapper is exported from `grep` module, but Rust implementation lives in `fd.rs`.
2. Shared scan source from `fs_cache` with same cache/no-cache split and stale-empty recheck policy.
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score
   - separator/punctuation-normalized scoring path
   - directory bonus and deterministic tie-break (`score desc`, then `path asc`)
4. Symlink entries are excluded from fuzzy results.

### Failure behavior

- Invalid glob pattern => error from `glob_util::compile_glob`.
- Search root must be an existing directory (`resolve_search_path`), otherwise error.
- Cancellation/timeouts propagate as abort errors via `CancelToken::heartbeat()` checks in loops.

### Malformed glob handling

`glob_util::build_glob_pattern` is tolerant:
- Normalizes `\` to `/`.
- Auto-prefixes simple recursive patterns with `**/` when `recursive=true`.
- Auto-closes unbalanced `{...` alternation groups before compile.

## 3) Shared scan/cache lifecycle (`fs_cache`)

`fs_cache` stores scan results as normalized relative entries (`path`, `fileType`, optional `mtime`) keyed by:
- canonical search root
- `include_hidden`
- `use_gitignore`

### Cache state transitions

1. **Miss / disabled**
   - TTL is `0` or key absent/expired -> fresh `collect_entries`.
2. **Hit**
   - Entry age `< cache_ttl_ms()` -> return cached entries + `cache_age_ms`.
3. **Stale-empty recheck** (caller policy in `glob`/`grep`/`fd`)
   - If query yields zero matches and `cache_age_ms >= empty_recheck_ms()`, force one rescan.
4. **Invalidation**
   - `invalidateFsScanCache(path?)`:
     - no arg: clear all keys
     - path arg: remove keys whose root prefixes that target path

### Stale-result tradeoff

- Cache favors low-latency repeated scans over immediate consistency.
- TTL window can return stale positives/negatives.
- Empty-result recheck reduces stale negatives for older cached scans at the cost of one extra scan.
- Explicit invalidation is the intended correctness hook after file mutations.

## 4) ANSI text utilities (`text`)

These are pure, in-memory utilities (no filesystem scanning).

### Boundaries and responsibilities

- **`text.rs` owns terminal-cell semantics**:
  - ANSI sequence parsing
  - grapheme-aware width and slicing
  - wrap/truncate/sanitize behavior
- **`grep.rs` line truncation (`maxColumns`) is separate**:
  - simple character-boundary truncation of matched lines with `...`
  - not ANSI-state-preserving and not terminal-cell width aware

### Key behaviors

- `wrapTextWithAnsi`: wraps by visible width, carries active SGR codes across wrapped lines.
- `truncateToWidth`: visible-cell truncation with ellipsis policy (`Unicode`, `Ascii`, `Omit`), optional right padding, and fast-path returning original JS string when unchanged.
- `sliceWithWidth`: column slicing with optional strict width enforcement.
- `extractSegments`: extracts before/after segments around an overlay while restoring ANSI state for the `after` segment.
- `sanitizeText`: strips ANSI escapes + control chars, drops lone surrogates, normalizes CR/LF by removing `\r`.
- `visibleWidth`: counts visible terminal cells (tabs use fixed `TAB_WIDTH` from Rust implementation).

### Failure behavior

Text functions generally return deterministic transformed output; errors are limited to JS string conversion boundaries (N-API argument conversion failures).

## 5) Syntax highlighting (`highlight`)

`highlight.rs` is pure transformation (no FS, no cache).

### Flow

1. Wrapper forwards `code`, optional `lang`, and ANSI color palette.
2. Rust resolves syntax by:
   - token/name lookup
   - extension lookup
   - alias table fallback (`ts/tsx/js -> JavaScript`, etc.)
   - fallback to plain text syntax when unresolved
3. Parse each line with syntect `ParseState` and scope stack.
4. Map scopes to 11 semantic color categories and inject/reset ANSI color codes.

### Failure behavior

- Per-line parse failure does not fail the call: that line is appended unhighlighted and processing continues.
- Unknown/unsupported language falls back to plain text syntax.

## Pure utility vs filesystem-dependent flows

| Flow | Filesystem access | Shared cache | Notes |
| --- | --- | --- | --- |
| `searchContent` / `hasMatch` | No | No | regex on provided bytes/string only |
| `text` module functions | No | No | ANSI/width/sanitization only |
| `highlight` module functions | No | No | syntax + ANSI coloring only |
| `glob` | Yes | Optional | directory scans + glob filtering |
| `fuzzyFind` | Yes | Optional | directory scans + fuzzy scoring |
| `grep` (file/dir path) | Yes | Optional (dir mode) | ripgrep over files, optional filters/callback |

## End-to-end lifecycle summary

1. Caller invokes TS wrapper with typed options.
2. Wrapper normalizes defaults (notably `glob`) and forwards to `native.*` export.
3. Rust validates/normalizes options and builds matcher/search config.
4. For filesystem flows, entries are scanned (cache hit/miss/rescan) then filtered/scored.
5. Worker loops periodically call cancel heartbeat; timeout/abort can terminate execution.
6. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, etc.).
7. TS wrapper returns typed JS objects (and optional per-match callbacks for `grep`/`glob`).
