# Natives Addon Loader Runtime

This document deep-dives the addon loading/validation layer in `@oh-my-pi/pi-natives`: how `native.ts` decides which `.node` file to load, when embedded payload extraction runs, and how startup failures are reported.

## Implementation files

- `packages/natives/src/native.ts`
- `packages/natives/src/embedded-addon.ts`
- `packages/natives/src/bindings.ts`
- `packages/natives/package.json`

## Scope and responsibility

Loader/runtime responsibilities are intentionally narrow:

- Build a platform/CPU-aware candidate list for addon filenames and directories.
- Optionally materialize an embedded addon into a versioned per-user cache directory.
- Attempt candidates in deterministic order.
- Reject stale or incompatible addons via `validateNative` before exposing bindings.

Out of scope here: module-specific grep/text/highlight behavior.

## Runtime inputs and derived state

At module initialization (`export const native = loadNative();`), `native.ts` computes static context:

- **Platform tag**: ``${process.platform}-${process.arch}`` (for example `darwin-arm64`).
- **Package version**: from `packages/natives/package.json` (`version` field).
- **Core directories**:
  - `nativeDir`: package-local `packages/natives/native`.
  - `execDir`: directory containing `process.execPath`.
  - `versionedDir`: `<getNativesDir()>/<packageVersion>`.
  - `userDataDir` fallback:
    - Windows: `%LOCALAPPDATA%/omp` (or `%USERPROFILE%/AppData/Local/omp`).
    - Non-Windows: `~/.local/bin`.
- **Compiled-binary mode** (`isCompiledBinary`): true if any of:
  - `PI_COMPILED` env var is set, or
  - `import.meta.url` contains Bun-embedded markers (`$bunfs`, `~BUN`, `%7EBUN`).
- **Variant override**: `PI_NATIVE_VARIANT` (`modern`/`baseline` only; invalid values ignored).
- **Selected variant**: explicit override, otherwise runtime AVX2 detection on x64 (`modern` if AVX2, else `baseline`).

## Platform support and tag resolution

`SUPPORTED_PLATFORMS` is fixed to:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

Behavior detail:

- Unsupported platforms are not rejected up-front.
- Loader still tries all computed candidates first.
- If nothing loads, it throws an explicit unsupported-platform error listing supported tags.

This preserves useful diagnostics for near-miss cases while still failing hard for truly unsupported targets.

## Variant selection (`modern` / `baseline` / default)

### x64 behavior

1. If `PI_NATIVE_VARIANT` is `modern` or `baseline`, that value wins.
2. Else detect AVX2 support:
   - Linux: scan `/proc/cpuinfo` for `avx2`.
   - macOS: query `sysctl` (`machdep.cpu.leaf7_features`, fallback `machdep.cpu.features`).
   - Windows: run PowerShell `[System.Runtime.Intrinsics.X86.Avx2]::IsSupported`.
3. Result:
   - AVX2 available -> `modern`
   - AVX2 unavailable/undetectable -> `baseline`

### Non-x64 behavior

- No variant is used; loader stays on the default filename (`pi_natives.<platform>-<arch>.node`).

### Filename construction

Given `tag = <platform>-<arch>`:

- Non-x64 or no variant: `pi_natives.<tag>.node`
- x64 + `modern`: try in order
  1. `pi_natives.<tag>-modern.node`
  2. `pi_natives.<tag>-baseline.node` (intentional fallback)
- x64 + `baseline`: only `pi_natives.<tag>-baseline.node`

The `addonLabel` used in final error messages is either `<tag>` or `<tag> (<variant>)`.

## Candidate path construction and fallback ordering

`native.ts` builds candidate pools before any `require(...)` call.

### Release candidates

Built from variant-resolved filename list and searched in this order:

- **Non-compiled runtime**:
  1. `<nativeDir>/<filename>`
  2. `<execDir>/<filename>`

- **Compiled runtime** (`PI_COMPILED` or Bun embedded markers):
  1. `<versionedDir>/<filename>`
  2. `<userDataDir>/<filename>`
  3. `<nativeDir>/<filename>`
  4. `<execDir>/<filename>`

`dedupedCandidates` removes duplicates while preserving first occurrence order.

### Final runtime sequence

At load time:

1. Optional embedded extraction candidate (if produced) is inserted at the front.
2. Remaining deduplicated candidates are tried in order.
3. First candidate that both `require(...)`s and passes `validateNative(...)` wins.

## Embedded addon extraction lifecycle

`embedded-addon.ts` defines a generated manifest shape:

- `platformTag`
- `version`
- `files[]` where each entry has `variant`, `filename`, `filePath`

Current checked-in default is `embeddedAddon: null`; compiled artifacts may replace this with real metadata.

### Extraction state machine

Extraction (`maybeExtractEmbeddedAddon`) runs only when all gates pass:

1. `isCompiledBinary === true`
2. `embeddedAddon !== null`
3. `embeddedAddon.platformTag === platformTag`
4. `embeddedAddon.version === packageVersion`
5. A variant-appropriate embedded file is found

Variant file selection mirrors runtime variant intent:

- Non-x64: prefer `default`, then first available file.
- x64 + `modern`: prefer `modern`, fallback to `baseline`.
- x64 + `baseline`: require `baseline`.

Materialization behavior:

1. Ensure `<versionedDir>` exists (`mkdirSync(..., { recursive: true })`).
2. If `<versionedDir>/<selected filename>` already exists, reuse it (no rewrite).
3. Else read embedded source `filePath` and write target file.
4. Return target path for highest-priority load attempt.

On failure, extraction does not crash immediately; it appends an error entry (directory creation or write failure) and loader proceeds to normal candidate probing.

## Lifecycle and state transitions

```text
Init
  -> Compute platform/version/variant/candidate lists
  -> (Compiled + embedded manifest matches?)
       yes -> Try extract embedded to versionedDir (record errors, continue)
       no  -> Skip extraction
  -> For each runtime candidate in order:
       require(candidate)
       -> success: validateNative
            -> pass: return bindings (READY)
            -> fail: record error, continue
       -> failure: record error, continue
  -> none loaded:
       if unsupported platform tag -> throw Unsupported platform
       else -> throw Failed to load (full tried-path diagnostics + hints)
```

## `validateNative` contract checks

`validateNative(bindings, source)` enforces a function-only contract over `NativeBindings` at startup.

Mechanics:

- For each required export name, it checks `typeof bindings[name] === "function"`.
- Missing names are aggregated.
- If any are missing, loader throws:
  - source addon path,
  - missing export list,
  - rebuild command hint.

This is a hard compatibility gate against stale binaries, partial builds, and symbol/name drift.

### JS API ↔ native export mapping (validation gate)

| JS binding name checked in `validateNative` | Expected native export name |
| --- | --- |
| `grep` | `grep` |
| `glob` | `glob` |
| `highlightCode` | `highlightCode` |
| `executeShell` | `executeShell` |
| `PtySession` | `PtySession` |
| `Shell` | `Shell` |
| `visibleWidth` | `visibleWidth` |
| `getSystemInfo` | `getSystemInfo` |
| `getWorkProfile` | `getWorkProfile` |
| `invalidateFsScanCache` | `invalidateFsScanCache` |

Note: `bindings.ts` declares only the base `cancelWork(id)` member; module `types.ts` files declaration-merge additional symbols that `validateNative` enforces.

## Failure behavior and diagnostics

## Unsupported platform

If all candidates fail and `platformTag` is not in `SUPPORTED_PLATFORMS`, loader throws:

- `Unsupported platform: <tag>`
- Full supported-platform list
- Explicit issue-reporting guidance

## Stale binary / mismatch symptoms

Typical stale mismatch signal:

- `Native addon missing exports (<candidate>). Missing: ...`

Common causes:

- Old `.node` binary from previous package version/API shape.
- Wrong variant artifact selected (for x64).
- New Rust export not present in loaded artifact.

Loader behavior:

- Records per-candidate missing-export failures.
- Continues probing remaining candidates.
- If no candidate validates, final error includes every attempted path with each failure message.

## Compiled-binary startup failures

In compiled mode final diagnostics include:

- expected versioned cache target paths (`<versionedDir>/<filename>`),
- remediation to delete stale `<versionedDir>` and rerun,
- direct release download `curl` commands for each expected filename.

## Non-compiled startup failures

In normal package/runtime mode final diagnostics include:

- reinstall hint (`bun install @oh-my-pi/pi-natives`),
- local rebuild command (`bun --cwd=packages/natives run build`),
- optional x64 variant build hint (`TARGET_VARIANT=baseline|modern ...`).

## Runtime behavior

- The loader always uses the release candidate chain.