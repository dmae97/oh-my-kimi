# Natives media + system utilities

This document covers the media/system/conversion exports currently present in `@oh-my-pi/pi-natives`: terminal SIXEL image encoding, HTML conversion, clipboard access, token counting, macOS appearance/power helpers, and work profiling.

## Implementation files

- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

There is no native `PhotonImage` class, `image.rs`, or ProjFS overlay helper module in the current `pi-natives` addon. General-purpose image decode/resize/encode is expected to live outside this native surface; the native image export here is only terminal SIXEL encoding.

## JS API ↔ Rust export/module mapping

| JS export                             | Rust N-API export              | Rust module     |
| ------------------------------------- | ------------------------------ | --------------- |
| `encodeSixel(bytes, width, height)`   | `encode_sixel`                 | `sixel.rs`      |
| `htmlToMarkdown(html, options?)`      | `html_to_markdown`             | `html.rs`       |
| `copyToClipboard(text)`               | `copy_to_clipboard`            | `clipboard.rs`  |
| `readImageFromClipboard()`            | `read_image_from_clipboard`    | `clipboard.rs`  |
| `countTokens(input, encoding?)`       | `count_tokens`                 | `tokens.rs`     |
| `detectMacOSAppearance()`             | `detect_mac_os_appearance`     | `appearance.rs` |
| `MacAppearanceObserver.start(cb)`     | `MacAppearanceObserver::start` | `appearance.rs` |
| `MacOSPowerAssertion.start(options?)` | `MacOSPowerAssertion::start`   | `power.rs`      |
| `getWorkProfile(lastSeconds)`         | `get_work_profile`             | `prof.rs`       |

## Data format boundaries and conversions

### SIXEL image encoding (`sixel`)

- **JS input boundary**: `Uint8Array` containing encoded image bytes.
- **Rust decode boundary**: format is guessed with `ImageReader::with_guessed_format()`, then decoded to `DynamicImage`.
- **Resize boundary**: image is resized with `resize_exact(..., FilterType::Lanczos3)` only when source dimensions differ from `targetWidthPx`/`targetHeightPx`.
- **Output boundary**: `encodeSixel(...)` returns a SIXEL escape string synchronously.

Supported decode formats are whatever the compiled `image` crate supports for `ImageReader` in this build (commonly PNG/JPEG/WebP/GIF). Invalid target dimensions (`0` width or height) fail with `Target SIXEL dimensions must be greater than zero`.

### HTML conversion (`html`)

- **JS input boundary**: HTML `string` + optional `{ cleanContent?: boolean; skipImages?: boolean }`.
- **Rust conversion boundary**: conversion is scheduled through `task::blocking("html_to_markdown", (), ...)`; there is no timeout/abort option on this export.
- **Output boundary**: Markdown `string` promise.

Conversion behavior:

- `cleanContent` defaults to `false`.
- When `cleanContent=true`, preprocessing is enabled with `PreprocessingPreset::Aggressive`, `remove_navigation=true`, and `remove_forms=true`.
- `skipImages` defaults to `false` and is passed to `html_to_markdown_rs::ConversionOptions`.

### Clipboard (`clipboard`)

- `copyToClipboard(text)` is a synchronous native call using `arboard::Clipboard::set_text`.
- `readImageFromClipboard()` runs in `task::blocking("clipboard.read_image", (), ...)`.
- Image read returns `null`/`undefined` when `arboard` reports `ContentNotAvailable`.
- Successful image read converts clipboard RGBA data into PNG bytes and returns `{ data: Uint8Array, mimeType: "image/png" }`.
- Clipboard access or image encoding failures reject/throw as native errors.

There is no current `packages/natives` TS wrapper that emits OSC52, handles Termux, or suppresses native clipboard failures. Any best-effort clipboard policy must live in consumers.

### Tokens (`tokens`)

- `countTokens(input, encoding?)` accepts a single string or an array of strings.
- Arrays return one aggregate token count; array elements are encoded in parallel via rayon.
- Default encoding is `O200kBase`; `Cl100kBase` is also exported.
- The implementation uses `encode_ordinary`, not special-token handling.
- BPE tables are initialized once through `LazyLock` and reused.

### macOS appearance and power helpers

- `detectMacOSAppearance()` returns `"dark"`, `"light"`, or `null` on non-macOS.
- `MacAppearanceObserver.start(callback)` returns a handle with `stop()`; on macOS it uses distributed notifications plus a 2-second polling fallback, and on non-macOS it is a no-op observer.
- `MacOSPowerAssertion.start(options?)` returns a handle with `stop()`; on macOS it acquires one or more IOKit assertions, and on other platforms it is a no-op handle.
- Power assertion options are `{ reason?, idle?, system?, user?, display? }`. If every boolean is unset or omitted, `idle` behavior is used by default.

### Work profiling (`prof`)

- **Collection boundary**: profiling samples are produced by `profile_region(tag)` guards in `task::blocking` and `task::future`.
- **Storage format**: fixed-size circular buffer (`MAX_SAMPLES = 10_000`) storing stack path, duration, and timestamp.
- **Output boundary**: `getWorkProfile(lastSeconds)` returns:
  - `folded`: folded-stack text (flamegraph input)
  - `summary`: markdown table summary
  - `svg`: optional flamegraph SVG
  - `totalMs`, `sampleCount`

## Lifecycle and state transitions

### SIXEL lifecycle

1. `encodeSixel(bytes, targetWidthPx, targetHeightPx)` validates target dimensions.
2. Rust guesses and decodes the encoded image.
3. Image is resized exactly to the target dimensions when needed.
4. Pixels are converted to RGBA8 and encoded with `icy_sixel::sixel_encode`.
5. The SIXEL escape string is returned synchronously.

Failure transitions:

- Format detection/decode failure throws.
- Invalid target dimensions throw.
- SIXEL encoding failure throws with `Failed to encode SIXEL: ...`.

### HTML lifecycle

1. `htmlToMarkdown(html, options)` schedules a blocking conversion task.
2. Conversion runs with defaulted options (`cleanContent=false`, `skipImages=false`) unless specified.
3. Returns markdown string or rejects with `Conversion error: ...`.

### Clipboard lifecycle

- Text copy constructs an `arboard::Clipboard` and calls `set_text` synchronously.
- Image read constructs an `arboard::Clipboard`, calls `get_image`, encodes PNG on success, maps `ContentNotAvailable` to `None`, and rejects other errors.

### Work profiling lifecycle

1. No explicit start: profiling is active when task helpers execute.
2. Every instrumented task scope records one sample on guard drop.
3. Samples overwrite oldest entries after buffer capacity is reached.
4. `getWorkProfile(lastSeconds)` reads a time window and derives folded/summary/svg artifacts.

Failure transitions:

- SVG generation failure is soft (`svg` omitted/undefined), while folded and summary still return.
- Empty sample windows return empty folded data and no SVG, not an error.

## Unsupported operations and error propagation

### SIXEL

- Unsupported or corrupted image input is a strict failure.
- Invalid SIXEL target dimensions are a strict failure.
- No JS fallback path is exposed by the natives package.

### HTML

- Conversion errors are strict failures.
- Option omission is defaulting, not failure.

### Clipboard

- Text copy is strict at the native API surface.
- Image read distinguishes "no image" (`null`/`undefined`) from operational failure (rejection).

### Work profiling

- Retrieval is strict for the function call itself.
- Flamegraph SVG generation is nullable/optional.
- Buffer truncation is expected ring-buffer behavior.

## Platform caveats

- Clipboard access depends on OS/session support exposed through `arboard`.
- macOS appearance and power helpers intentionally return no-op/null behavior on unsupported platforms.
- ProjFS is not exposed by this media/system native utility surface. Isolation backend selection, including any ProjFS support, lives in the separate `iso` subsystem.
