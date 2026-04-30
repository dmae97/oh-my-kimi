# Natives Build, Release, and Debugging Runbook

This runbook describes how the `@oh-my-pi/pi-natives` build pipeline produces `.node` addons, how compiled distributions load them, and how to debug loader/build failures.

It follows the architecture terms from `docs/natives-architecture.md`:
- **build-time artifact production** (`scripts/build-native.ts`)
- **embedded addon manifest generation** (`scripts/embed-native.ts`)
- **runtime addon loading + validation gate** (`src/native.ts`)

## Implementation files

- `packages/natives/scripts/build-native.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/package.json`
- `packages/natives/src/native.ts`
- `crates/pi-natives/Cargo.toml`

## Build pipeline overview

### 1) Build entrypoints

`packages/natives/package.json` scripts:

- `bun scripts/build-native.ts` (`build`) → release build
- `bun scripts/embed-native.ts` (`embed:native`) → generate `src/embedded-addon.ts` from built files

### 2) Rust artifact build

`build-native.ts` runs Cargo in `crates/pi-natives`:

- base command: `cargo build --release`
- cross target adds `--target <CROSS_TARGET>`

`crates/pi-natives/Cargo.toml` declares `crate-type = ["cdylib"]`, so Cargo emits a shared library (`.so`/`.dylib`/`.dll`) that is then copied/renamed to a `.node` addon filename.

### 3) Artifact discovery and install

After Cargo completes, `build-native.ts` scans candidate output directories in order:

1. `${CARGO_TARGET_DIR}` (if set)
2. `<repo>/target`
3. `crates/pi-natives/target`

For each root it checks profile directories:
- cross build: `<root>/<crossTarget>/<profile>` then `<root>/<profile>`
- native build: `<root>/<profile>`

Then it looks for one of:
- `libpi_natives.so`
- `libpi_natives.dylib`
- `pi_natives.dll`
- `libpi_natives.dll`

When found, it atomically installs into `packages/natives/native/` with temp-file + rename semantics (Windows fallback handles locked DLL replacement failures explicitly).

## Target/variant model and naming conventions

## Platform tag

Both build and runtime use platform tag:

`<platform>-<arch>` (example: `darwin-arm64`, `linux-x64`)

## Variant model (x64 only)

x64 supports CPU variants:
- `modern` (AVX2-capable path)
- `baseline` (fallback)

Non-x64 uses a single default artifact (no variant suffix).

### Output filenames

Release builds:
- x64: `pi_natives.<platform>-<arch>-modern.node` or `...-baseline.node`
- non-x64: `pi_natives.<platform>-<arch>.node`

Runtime loader candidate order in `native.ts`:
- release candidates
- compiled mode prepends extracted/cache candidates before package-local files

## Environment flags and build options

## Runtime flags

- `PI_NATIVE_VARIANT` (loader behavior, x64 only): force `modern` or `baseline` selection at runtime
- `PI_COMPILED` (loader behavior): enable compiled-binary candidate/extraction behavior

## Build-time flags/options

- `CROSS_TARGET`: passed to Cargo `--target`
- `TARGET_PLATFORM`: override output platform tag naming
- `TARGET_ARCH`: override output arch naming
- `TARGET_VARIANT` (x64 only): force `modern` or `baseline` for output filename and RUSTFLAGS policy
- `CARGO_TARGET_DIR`: additional root when searching Cargo outputs
- `RUSTFLAGS`:
  - if unset and not cross-compiling, script sets:
    - modern: `-C target-cpu=x86-64-v3`
    - baseline: `-C target-cpu=x86-64-v2`
    - non-x64 / no variant: `-C target-cpu=native`
  - if already set, script does not override

## Build state/lifecycle transitions

### Build lifecycle (`build-native.ts`)

1. **Init**: parse args/env (target overrides, cross flags)
2. **Variant resolve**:
   - non-x64 → no variant
   - x64 + `TARGET_VARIANT` → explicit variant
   - x64 cross-build without `TARGET_VARIANT` → hard error
   - x64 local build without override → detect host AVX2
3. **Compile**: run Cargo with resolved profile/target
4. **Locate artifact**: scan target roots/profile dirs/library names
5. **Install**: copy + atomic rename into `packages/natives/native`
6. **Complete**: output addon ready for loader candidates

Failure exits happen at any stage with explicit error text (invalid variant, failed cargo build, missing output library, install/rename failure).

### Embed lifecycle (`embed-native.ts`)

1. **Init**: compute platform tag from `TARGET_PLATFORM`/`TARGET_ARCH` or host values
2. **Candidate set**:
   - x64 expects both `modern` and `baseline`
   - non-x64 expects one default file
3. **Validate availability** in `packages/natives/native`
4. **Generate manifest** (`src/embedded-addon.ts`) with Bun `file` imports and package version
5. **Runtime extraction ready** for compiled mode

`--reset` bypasses validation and writes a null manifest stub (`embeddedAddon = null`).

## Dev workflow vs shipped/compiled behavior

## Local development workflow

Typical local loop:

1. Build addon: `bun --cwd=packages/natives run build`
2. Loader in `native.ts` resolves package-local `native/` (and executable-dir fallback) candidates
3. `validateNative` enforces export compatibility before wrappers use the binding

## Shipped/compiled binary workflow

In compiled mode (`PI_COMPILED` or Bun embedded markers):

1. Loader computes versioned cache dir: `<getNativesDir()>/<packageVersion>` (operationally `~/.omp/natives/<version>`)
2. If embedded manifest matches current platform+version, loader may extract selected embedded file into that versioned dir
3. Runtime candidate order includes:
   - versioned cache dir
   - legacy compiled-binary dir (`%LOCALAPPDATA%/omp` on Windows, `~/.local/bin` elsewhere)
   - package/executable directories
4. First successfully loaded addon still must pass `validateNative`

This is why packaging + runtime loader expectations must align: filenames, platform tags, and exported symbols must match what `native.ts` probes and validates.

## JS API ↔ Rust export mapping (validation gate subset)

`native.ts` requires these JS-visible exports to exist on the loaded addon. They map to Rust N-API exports in `crates/pi-natives/src`:

| JS name required by `validateNative` | Rust export declaration | Rust source file |
| --- | --- | --- |
| `glob` | `#[napi] pub fn glob(...)` | `crates/pi-natives/src/glob.rs` |
| `grep` | `#[napi] pub fn grep(...)` | `crates/pi-natives/src/grep.rs` |
| `search` | `#[napi] pub fn search(...)` | `crates/pi-natives/src/grep.rs` |
| `highlightCode` | `#[napi] pub fn highlight_code(...)` | `crates/pi-natives/src/highlight.rs` |
| `getSystemInfo` | `#[napi] pub fn get_system_info(...)` | `crates/pi-natives/src/system_info.rs` |
| `getWorkProfile` | `#[napi] pub fn get_work_profile(...)` (camel-cased export) | `crates/pi-natives/src/prof.rs` |
| `invalidateFsScanCache` | `#[napi] pub fn invalidate_fs_scan_cache(...)` | `crates/pi-natives/src/fs_cache.rs` |

If any required symbol is missing, loader fails fast with a rebuild hint.

## Failure behavior and diagnostics

## Build-time failures

- Invalid variant configuration:
  - `TARGET_VARIANT` set on non-x64 → immediate error
  - x64 cross-build without explicit `TARGET_VARIANT` → immediate error
- Cargo build failure:
  - script surfaces non-zero exit and stderr
- Artifact not found:
  - script prints every checked profile directory
- Install failure:
  - explicit message; Windows includes locked-file hint

## Runtime loader failures (`native.ts`)

- Unsupported platform tag:
  - throws with supported platform list
- No candidate could load:
  - throws with full candidate error list and mode-specific remediation hints
- Missing exports:
  - throws with exact missing symbol names and rebuild command
- Embedded extraction problems:
  - extraction mkdir/write errors recorded and included in final diagnostics

## Troubleshooting matrix

| Symptom | Likely cause | Verify | Fix |
| --- | --- | --- | --- |
| `Native addon missing exports ... Missing: <name>` | Stale `.node` binary, Rust export name mismatch, or wrong binary loaded | Inspect export list for the binary | Rebuild `build`; ensure Rust `#[napi]` export name (or explicit alias when needed) matches JS key; remove stale cached/versioned files |
| x64 machine loads baseline when modern expected | `PI_NATIVE_VARIANT=baseline`, no AVX2 detected, or only baseline file present | Check `PI_NATIVE_VARIANT`; inspect `native/` for `-modern` file | Build modern variant (`TARGET_VARIANT=modern ... build`) and ensure file is shipped |
| Cross-build produces unusable/wrong-labeled binary | Mismatch between `CROSS_TARGET` and `TARGET_PLATFORM`/`TARGET_ARCH`, or missing `TARGET_VARIANT` for x64 | Confirm env tuple and output filename | Re-run with consistent env values and explicit x64 `TARGET_VARIANT` |
| Compiled binary fails after upgrade | Stale extracted cache (`~/.omp/natives/<old-or-mismatched-version>`) or embedded manifest mismatch | Inspect versioned natives dir and loader error list | Delete versioned natives cache for the package version and rerun; regenerate embedded manifest during packaging |
| Loader probes many paths and none work | Platform mismatch or missing release artifact in package `native/` | Check `platformTag` vs actual filename(s) | Ensure built filename exactly matches `pi_natives.<platform>-<arch>(-variant).node` convention and package includes `native/` |
| `embed:native` fails with "Incomplete native addons" | Required variant files not built before embedding | Check expected vs found list in error text | Build required files first (x64: both modern+baseline; non-x64: default), then rerun `embed:native` |

## Operational commands

```bash
# Release artifact for current host
bun --cwd=packages/natives run build

# Build explicit x64 variants
TARGET_VARIANT=modern bun --cwd=packages/natives run build
TARGET_VARIANT=baseline bun --cwd=packages/natives run build

# Generate embedded addon manifest from built native files
bun --cwd=packages/natives run embed:native

# Reset embedded manifest to null stub
bun --cwd=packages/natives run embed:native -- --reset
```