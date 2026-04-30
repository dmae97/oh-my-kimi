# Natives media + system utilities

This document is a subsystem deep-dive for the **system/media/conversion primitives** layer described in [`docs/natives-architecture.md`](./natives-architecture.md): `image`, `html`, `clipboard`, and `work` profiling.

## Implementation files

- `crates/pi-natives/src/image.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/src/image/index.ts`
- `packages/natives/src/image/types.ts`
- `packages/natives/src/html/index.ts`
- `packages/natives/src/html/types.ts`
- `packages/natives/src/clipboard/index.ts`
- `packages/natives/src/clipboard/types.ts`
- `packages/natives/src/work/index.ts`
- `packages/natives/src/work/types.ts`

> Note: there is no `crates/pi-natives/src/work.rs`; work profiling is implemented in `prof.rs` and fed by instrumentation in `task.rs`.

## TS API ↔ Rust export/module mapping

| TS export (packages/natives)                | Rust N-API export                                                       | Rust module                           |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| `PhotonImage.parse(bytes)`                  | `PhotonImage::parse`                                                     | `image.rs`                            |
| `PhotonImage#resize(width, height, filter)` | `PhotonImage::resize`                                                    | `image.rs`                            |
| `PhotonImage#encode(format, quality)`       | `PhotonImage::encode`                                                    | `image.rs`                            |
| `htmlToMarkdown(html, options)`             | `html_to_markdown`                                                       | `html.rs`                             |
| `copyToClipboard(text)`                     | `copy_to_clipboard` + TS fallback logic                                  | `clipboard.rs` + `clipboard/index.ts` |
| `readImageFromClipboard()`                  | `read_image_from_clipboard`                                              | `clipboard.rs`                        |
| `getWorkProfile(lastSeconds)`               | `get_work_profile`                                                      | `prof.rs`                             |

## Data format boundaries and conversions

### Image (`image`)

- **JS input boundary**: `Uint8Array` encoded image bytes.
- **Rust decode boundary**: bytes are copied to `Vec<u8>`, format is guessed with `ImageReader::with_guessed_format()`, then decoded to `DynamicImage`.
- **In-memory state**: `PhotonImage` stores `Arc<DynamicImage>`.
- **Output boundary**: `encode(format, quality)` returns `Promise<Uint8Array>` (Rust `Vec<u8>`).

Format IDs are numeric:

- `0`: PNG
- `1`: JPEG
- `2`: WebP (lossless encoder)
- `3`: GIF

Constraints:

- `quality` is only used for JPEG.
- PNG/WebP/GIF ignore `quality`.
- Unsupported format IDs fail (`Invalid image format: <id>`).

### HTML conversion (`html`)

- **JS input boundary**: HTML `string` + optional object `{ cleanContent?: boolean; skipImages?: boolean }`.
- **Rust conversion boundary**: `String` input is converted by `html_to_markdown_rs::convert`.
- **Output boundary**: Markdown `string`.

Conversion behavior:

- `cleanContent` defaults to `false`.
- When `cleanContent=true`, preprocessing is enabled with `PreprocessingPreset::Aggressive` and hard-removal flags for navigation/forms.
- `skipImages` defaults to `false`.

### Clipboard (`clipboard`)

- **Text path**:
  - TS first emits OSC 52 (`\x1b]52;c;<base64>\x07`) when stdout is a TTY.
  - Same text is then attempted via native clipboard API (`native.copyToClipboard`) as best-effort.
  - On Termux, TS attempts `termux-clipboard-set` first.
- **Image read path**:
  - Rust reads raw image from `arboard`.
  - Rust re-encodes it to PNG bytes (`image` crate), returns `{ data: Uint8Array, mimeType: "image/png" }`.
  - TS returns `null` early on Termux or Linux sessions without display server (`DISPLAY`/`WAYLAND_DISPLAY` missing).

### Work profiling (`work`)

- **Collection boundary**: profiling samples are produced by `profile_region(tag)` guards in `task::blocking` and `task::future`.
- **Storage format**: fixed-size circular buffer (`MAX_SAMPLES = 10_000`) storing stack path + duration (`μs`) + timestamp (`μs since process start`).
- **Output boundary**: `getWorkProfile(lastSeconds)` returns object:
  - `folded`: folded-stack text (flamegraph input)
  - `summary`: markdown table summary
  - `svg`: optional flamegraph SVG
  - `totalMs`, `sampleCount`

## Lifecycle and state transitions

### Image lifecycle

1. `PhotonImage.parse(bytes)` schedules a blocking decode task (`image.decode`).
2. On success, a native `PhotonImage` handle exists in JS.
3. `resize(...)` creates a new native handle (`image.resize`), old and new handles can coexist.
4. `encode(...)` materializes bytes (`image.encode`) without mutating image dimensions.

Failure transitions:

- Format detection/decode failure rejects parse promise.
- Encode failure rejects encode promise.
- Invalid format ID rejects encode promise.

### HTML lifecycle

1. `htmlToMarkdown(html, options)` schedules a blocking conversion task.
2. Conversion runs with defaulted options (`cleanContent=false`, `skipImages=false`) unless specified.
3. Returns markdown string or rejects.

Failure transitions:

- Converter failure returns rejected promise (`Conversion error: ...`).

### Clipboard lifecycle

`copyToClipboard(text)` is intentionally best-effort and multi-path:

1. If TTY: attempt OSC 52 write (base64 payload).
2. Try Termux command when `TERMUX_VERSION` is set.
3. Try native `arboard` text copy.
4. Swallow errors at TS layer.

`readImageFromClipboard()` strictness differs by stage:

1. TS hard-gates unsupported runtime contexts (Termux/headless Linux) to `null`.
2. Rust `arboard` read runs only when TS allows it.
3. `ContentNotAvailable` maps to `null`.
4. Other Rust errors reject.

### Work profiling lifecycle

1. No explicit start: profiling is always on when task helpers execute.
2. Every instrumented task scope records one sample on guard drop.
3. Samples overwrite oldest entries after buffer capacity is reached.
4. `getWorkProfile(lastSeconds)` reads a time window and derives folded/summary/svg artifacts.

Failure transitions:

- SVG generation failure is soft-fail (`svg: null`), while folded and summary still return.
- Empty sample window returns empty folded data and `svg: null`, not an error.

## Unsupported operations and error propagation

### Image

- Unsupported decode input or corrupted bytes: strict failure (promise rejection).
- Unsupported encode format ID: strict failure.
- No best-effort fallback path in TS wrapper.

### HTML

- Conversion errors are strict failures (rejection).
- Option omission is best-effort defaulting, not failure.

### Clipboard

- Text copy is best-effort at TS layer: operational failures are suppressed.
- Image read distinguishes "no image" (`null`) from operational failure (rejection).
- Termux/headless Linux are treated as unsupported contexts for image read (`null`).

### Work profiling

- Retrieval is strict for function call itself, but artifact generation is partially best-effort (`svg` nullable).
- Buffer truncation is expected behavior (ring buffer), not data loss bug.

## Platform caveats

- **Clipboard text**: OSC 52 depends on terminal support; native clipboard access depends on desktop environment/session.
- **Clipboard image read**: blocked in TS for Termux and Linux without display server.
