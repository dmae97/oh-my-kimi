# Natives Binding Contract (TypeScript Side)

This document defines the TypeScript-side contract that sits between `@oh-my-pi/pi-natives` callers and the loaded N-API addon.

It focuses on three pieces:

1. contract shape (`NativeBindings` + module augmentation),
2. wrapper behavior (`src/<module>/index.ts`),
3. public export surface (`src/index.ts`).

## Implementation files

- `packages/natives/src/bindings.ts`
- `packages/natives/src/native.ts`
- `packages/natives/src/index.ts`
- `packages/natives/src/clipboard/types.ts`
- `packages/natives/src/clipboard/index.ts`
- `packages/natives/src/glob/types.ts`
- `packages/natives/src/glob/index.ts`
- `packages/natives/src/grep/types.ts`
- `packages/natives/src/grep/index.ts`
- `packages/natives/src/highlight/types.ts`
- `packages/natives/src/highlight/index.ts`
- `packages/natives/src/html/types.ts`
- `packages/natives/src/html/index.ts`
- `packages/natives/src/image/types.ts`
- `packages/natives/src/image/index.ts`
- `packages/natives/src/keys/types.ts`
- `packages/natives/src/keys/index.ts`
- `packages/natives/src/ps/types.ts`
- `packages/natives/src/ps/index.ts`
- `packages/natives/src/pty/types.ts`
- `packages/natives/src/pty/index.ts`
- `packages/natives/src/shell/types.ts`
- `packages/natives/src/shell/index.ts`
- `packages/natives/src/system-info/types.ts`
- `packages/natives/src/system-info/index.ts`
- `packages/natives/src/text/types.ts`
- `packages/natives/src/text/index.ts`
- `packages/natives/src/work/types.ts`
- `packages/natives/src/work/index.ts`

## Contract model

`packages/natives/src/bindings.ts` defines the base contract:

- `NativeBindings` (base interface, currently includes `cancelWork(id: number): void`)
- `Cancellable` (`timeoutMs?: number`, `signal?: AbortSignal`)
- `TsFunc<T>` callback shape used by N-API threadsafe callbacks

Each module adds its own fields by declaration merging:

```ts
// packages/natives/src/<module>/types.ts
declare module "../bindings" {
	interface NativeBindings {
		grep(options: GrepOptions, onMatch?: TsFunc<GrepMatch>): Promise<GrepResult>;
	}
}
```

This keeps one aggregate binding interface without a monolithic central type file.

## Declaration-merging lifecycle and state transitions

### 1) Compile-time type assembly

- `bindings.ts` provides the base `NativeBindings` symbol.
- Every `src/<module>/types.ts` augments `NativeBindings`.
- `src/native.ts` imports all `./<module>/types` files for side effects so the merged contract is in scope where `NativeBindings` is used.

State transition: **Base contract** → **Merged contract**.

### 2) Runtime addon load and validation gate

- `src/native.ts` loads candidate `.node` binaries.
- Loaded object is treated as `NativeBindings` and immediately passed through `validateNative(...)`.
- `validateNative` verifies required export keys by `typeof bindings[name] === "function"`.

State transition: **Untrusted addon object** → **Validated native binding object** (or hard failure).

### 3) Wrapper invocation

- Module wrappers in `src/<module>/index.ts` call `native.<export>`.
- Wrappers adapt defaults and callback shape (`(err, value)` to value-only callback patterns in JS APIs).
- `src/index.ts` re-exports module wrappers/types as the public package API.

State transition: **Validated raw bindings** → **Ergonomic public API**.

## Wrapper responsibilities

Wrappers are intentionally thin; they do not re-implement native logic.

Primary responsibilities:

- **Argument normalization/defaulting**
  - `glob()` resolves `options.path` to absolute path and defaults `hidden`, `gitignore`, `recursive`.
  - `hasMatch()` fills default flags (`ignoreCase`, `multiline`) before native call.
- **Callback adaptation**
  - `grep()`, `glob()`, `executeShell()` convert `TsFunc<T>` (`error, value`) into user callback receiving only successful values.
- **Environment or policy behavior around native calls**
  - Clipboard wrapper adds OSC52/Termux/headless handling and treats copy as best effort.
- **Public naming and re-export curation**
  - `searchContent()` maps to native export `search`.

## Public export surface organization

`packages/natives/src/index.ts` is the canonical public barrel. It groups exports by capability domain:

- Search/text: `grep`, `glob`, `text`, `highlight`
- Execution/process/terminal: `shell`, `pty`, `ps`, `keys`
- System/media/conversion: `image`, `html`, `clipboard`, `system-info`, `work`

Maintainer rule: if a wrapper is not re-exported from `src/index.ts`, it is not part of the intended public package surface.

## JS API ↔ native export mapping (representative)

The Rust side uses N-API export names (typically from `#[napi]` snake_case -> camelCase conversion, with occasional explicit aliases) that must match these binding keys.

| Category | Public JS API (wrapper) | Native binding key | Return type | Async? |
|---|---|---|---|---|
| Grep | `grep(options, onMatch?)` | `grep` | `Promise<GrepResult>` | Yes |
| Grep | `searchContent(content, options)` | `search` | `SearchResult` | No |
| Grep | `hasMatch(content, pattern, opts?)` | `hasMatch` | `boolean` | No |
| Grep | `fuzzyFind(options)` | `fuzzyFind` | `Promise<FuzzyFindResult>` | Yes |
| Glob | `glob(options, onMatch?)` | `glob` | `Promise<GlobResult>` | Yes |
| Glob | `invalidateFsScanCache(path?)` | `invalidateFsScanCache` | `void` | No |
| Shell | `executeShell(options, onChunk?)` | `executeShell` | `Promise<ShellExecuteResult>` | Yes |
| Shell | `Shell` | `Shell` | class constructor | N/A |
| PTY | `PtySession` | `PtySession` | class constructor | N/A |
| Text | `truncateToWidth(...)` | `truncateToWidth` | `string` | No |
| Text | `sliceWithWidth(...)` | `sliceWithWidth` | `SliceWithWidthResult` | No |
| Text | `visibleWidth(text)` | `visibleWidth` | `number` | No |
| Highlight | `highlightCode(code, lang, colors)` | `highlightCode` | `string` | No |
| HTML | `htmlToMarkdown(html, options?)` | `htmlToMarkdown` | `Promise<string>` | Yes |
| System | `getSystemInfo()` | `getSystemInfo` | `SystemInfo` | No |
| Work | `getWorkProfile(lastSeconds)` | `getWorkProfile` | `WorkProfile` | No |
| Process | `killTree(pid, signal)` | `killTree` | `number` | No |
| Process | `listDescendants(pid)` | `listDescendants` | `number[]` | No |
| Clipboard | `copyToClipboard(text)` | `copyToClipboard` | `Promise<void>` (best effort wrapper behavior) | Yes |
| Clipboard | `readImageFromClipboard()` | `readImageFromClipboard` | `Promise<ClipboardImage \| null>` | Yes |
| Keys | `parseKey(data, kittyProtocolActive)` | `parseKey` | `string \| null` | No |

## Sync vs async contract differences

The contract mixes sync and async APIs; wrappers preserve native call style rather than forcing one model:

- **Promise-based async exports** for I/O or long-running work (`grep`, `glob`, `htmlToMarkdown`, `executeShell`, clipboard, image operations).
- **Synchronous exports** for deterministic in-memory transforms/parsers (`search`, `hasMatch`, highlighting, text width/slicing, key parsing, process queries).
- **Constructor exports** for stateful runtime objects (`Shell`, `PtySession`, `PhotonImage`).

Implication for maintainers: changing sync ↔ async for an existing export is a breaking API and contract change across wrappers and callers.

## Object and enum typing patterns

### Object patterns (`#[napi(object)]`-style JS objects)

TS models object-shaped native values as interfaces, for example:

- `GrepResult`, `SearchResult`, `GlobResult`
- `SystemInfo`, `WorkProfile`
- `ClipboardImage`, `ParsedKittyResult`

These are structural contracts at compile time; runtime shape correctness is owned by native implementation.

### Enum patterns

Numeric native enums are represented as `const enum` values in TS:

- `FileType` (`1=file`, `2=dir`, `3=symlink`)
- `ImageFormat` (`0=PNG`, `1=JPEG`, `2=WEBP`, `3=GIF`)
- `SamplingFilter`, `Ellipsis`, `KeyEventType`

Callers see named enum members; the binding boundary passes numbers.

## How mismatches are caught

Mismatch detection happens at two layers:

1. **Compile-time TypeScript contract checks**
   - Wrappers call `native.<name>` against merged `NativeBindings`.
   - Missing/renamed binding keys break TS type-checking in wrappers.

2. **Runtime validation in `validateNative`**
   - After load, `native.ts` checks required exports and throws if any are missing.
   - Error message includes missing keys and rebuild instruction.

This catches the common stale-binary drift: wrapper/type exists but loaded `.node` lacks the export.

## Failure behavior and caveats

### Load/validation failures (hard failures)

- Addon load failure or unsupported platform throws during module init in `native.ts`.
- Missing required exports throws before wrappers are usable.

Effect: package fails fast rather than deferring failure to first call.

### Wrapper-level behavior differences

- Some wrappers intentionally soften failures (`copyToClipboard` is best effort and swallows native failure).
- Streaming callbacks ignore callback error payloads and only forward successful value events.

### Type-level caveats (runtime stricter than TS)

- TS optional fields do not guarantee semantic validity; native layer can still reject malformed values.
- `const enum` typing does not prevent out-of-range numeric values from untyped callers at runtime.
- `validateNative` checks only presence/function-ness of required exports, not deep argument/return-shape compatibility.
- `bindings.ts` includes `cancelWork(id)` in the base interface, but current runtime validation list does not enforce that key.

## Maintainer checklist for binding changes

When adding/changing an export, update all of:

1. `src/<module>/types.ts` (augmentation + contract types)
2. `src/<module>/index.ts` (wrapper behavior)
3. `src/native.ts` imports for the module types (if new module)
4. `validateNative` required export checks
5. `src/index.ts` public re-exports

Skipping any step creates either compile-time drift or runtime load-time failure.