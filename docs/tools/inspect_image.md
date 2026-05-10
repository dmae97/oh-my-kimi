# inspect_image

> Send a local image file to a vision-capable model and return text analysis.

## Source
- Entry: `packages/coding-agent/src/tools/inspect-image.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/inspect-image.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/inspect-image-renderer.ts` — TUI call/result rendering.
  - `packages/coding-agent/src/utils/image-loading.ts` — path resolution, type detection, size gate, optional resize.
  - `packages/coding-agent/src/utils/image-resize.ts` — downscale and recompress oversized images.
  - `packages/coding-agent/src/tools/path-utils.ts` — resolve input path relative to session cwd.
  - `packages/utils/src/mime.ts` — detect supported image formats from file bytes.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Image path passed to `loadImageInput`; resolved relative to `session.cwd` by `resolveReadPath(...)`. |
| `question` | `string` | Yes | User prompt sent as a text content block alongside the image. |

## Outputs
The tool returns a single `AgentToolResult`:

- `content`: one text block, `[{ type: "text", text }]`, where `text` is the concatenated assistant text content from the model response.
- `details`:
  - `model`: `<provider>/<id>` of the selected model.
  - `imagePath`: resolved filesystem path returned by `loadImageInput(...)`.
  - `mimeType`: MIME type actually sent to the model after optional resize/re-encode.

Model-visible output is single-shot, not streamed by this tool.

TUI rendering adds presentation-only truncation from `packages/coding-agent/src/tools/inspect-image-renderer.ts`:

- call preview truncates `question` to 100 columns,
- result view shows 4 lines collapsed or 16 lines expanded,
- each rendered output line is truncated to 120 columns,
- footer metadata shows `model · mimeType` when present.

## Flow
1. `InspectImageTool.execute(...)` rejects immediately if `images.blockImages` is enabled in session settings.
2. It reads `session.modelRegistry`; missing registry, empty registry, missing API key, or unresolved model each raise `ToolError` from `packages/coding-agent/src/tools/inspect-image.ts`.
3. Model selection tries, in order, `pi/vision`, `pi/default`, the active model string from the session, then `availableModels[0]`. `expandRoleAlias(...)` and `resolveModelFromString(...)` handle each lookup.
4. The chosen model must advertise `input.includes("image")`; otherwise execution fails before reading the file.
5. `loadImageInput(...)` in `packages/coding-agent/src/utils/image-loading.ts` resolves the path with `resolveReadPath(...)`, detects MIME type with `readImageMetadata(...)`, and rejects files larger than `MAX_IMAGE_INPUT_BYTES` (`20 * 1024 * 1024`, 20 MiB) using `ImageInputTooLargeError`.
6. `readImageMetadata(...)` in `packages/utils/src/mime.ts` inspects file headers only. Supported detected MIME types are `image/png`, `image/jpeg`, `image/gif`, and `image/webp`.
7. If `images.autoResize` is true, `loadImageInput(...)` calls `resizeImage(...)`. Resize failures are swallowed there and the original bytes are kept.
8. If MIME detection returned no supported image type, `execute(...)` throws `ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.")`.
9. The tool calls `completeSimple(...)` with one user message containing two content parts in order:
   - `{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType }`
   - `{ type: "text", text: params.question }`
10. `systemPrompt` is a one-element array rendered from `packages/coding-agent/src/prompts/tools/inspect-image-system.md`.
11. If the model response stop reason is `error` or `aborted`, the tool maps that to `ToolError`.
12. `extractResponseText(...)` concatenates only `text` content blocks from the assistant message, trims the result, and fails if nothing remains.
13. Success returns the text plus `details`; `inspectImageToolRenderer` formats the result for the TUI.

## Modes / Variants
- **Original image path**: `images.autoResize` disabled. The original file bytes are base64-encoded and sent with the detected MIME type.
- **Auto-resized path**: `images.autoResize` enabled. `resizeImage(...)` may downscale and re-encode the image before upload.
- **Unsupported image path**: file exists but header sniffing does not identify PNG/JPEG/GIF/WEBP. The tool returns a `ToolError` before any model call.
- **Oversize image path**: file size exceeds 20 MiB before upload. The tool returns a `ToolError` before any model call.

## Side Effects
- Filesystem
  - Resolves and reads the target image from disk.
  - Stats the file once with `Bun.file(...).stat()` and reads it fully with `fs.readFile(...)`.
- Network
  - Sends the final base64 image payload plus question text to the selected model through `completeSimple(...)`.
- Session state
  - Reads session settings, active model preferences, cwd, and model registry.
- Background work / cancellation
  - Passes the caller `AbortSignal` into `completeSimple(...)`.
  - Image preprocessing is local and not cancellation-aware in these helpers.

## Limits & Caps
- Supported detected input formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp` (`SUPPORTED_IMAGE_MIME_TYPES` in `packages/utils/src/mime.ts`).
- Metadata sniff cap: `DEFAULT_IMAGE_METADATA_HEADER_BYTES = 256 * 1024` bytes. Format detection only reads up to 256 KiB from the file header.
- Upload input cap: `MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024` bytes (20 MiB) in `packages/coding-agent/src/utils/image-loading.ts`.
- Auto-resize defaults in `packages/coding-agent/src/utils/image-resize.ts`:
  - `maxWidth: 1568`
  - `maxHeight: 1568`
  - `maxBytes: 500 * 1024` bytes (500 KiB target)
  - `jpegQuality: 75`
- Resize fast path: if the original image is already within `1568x1568` and within `maxBytes / 4` (125 KiB by default), `resizeImage(...)` returns the original bytes unchanged.
- Resize quality ladder: after the first encode pass, lossy retries use qualities `[70, 60, 50, 40]`.
- Resize dimension ladder: if quality reduction still misses the byte target, retries scale dimensions by `[1.0, 0.75, 0.5, 0.35, 0.25]` and stop if either dimension would fall below `100` pixels.
- First resize pass encodes PNG, JPEG, and WebP, then keeps the smallest encoded buffer. Fallback passes encode JPEG and WebP only, again keeping the smaller output.
- Renderer caps:
  - `INSPECT_QUESTION_PREVIEW_WIDTH = 100`
  - `INSPECT_OUTPUT_COLLAPSED_LINES = 4`
  - `INSPECT_OUTPUT_EXPANDED_LINES = 16`
  - `INSPECT_OUTPUT_LINE_WIDTH = 120`

## Errors
- Settings gate:
  - `Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.`
- Model resolution / capability:
  - `Model registry is unavailable for inspect_image.`
  - `No models available for inspect_image.`
  - `Unable to resolve a model for inspect_image.`
  - `Resolved model <provider>/<id> does not support image input. Configure a vision-capable model for modelRoles.vision.`
  - `No API key available for <provider>/<id>. Configure credentials for this provider or choose another vision-capable model.`
- Input file:
  - `Image file too large: <size> exceeds <limit> limit.` from `ImageInputTooLargeError`, remapped to `ToolError`.
  - `inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.` when header sniffing fails.
- Model call:
  - `inspect_image request failed.` if the response stop reason is `error` without a provider message.
  - Provider `errorMessage` is passed through when present.
  - `inspect_image request aborted.` on aborted responses.
  - `inspect_image model returned no text output.` when the assistant message contains no text blocks after filtering.

Failures surface as thrown `ToolError`s from `execute(...)`; the normal success return shape is not used for error reporting.

## Notes
- The model-facing prompt path on disk is `packages/coding-agent/src/prompts/tools/inspect-image.md`; the assignment's underscore form does not exist.
- Format support is based on file content, not filename extension. Renaming a non-image file to `.png` does not make it valid.
- `resolveReadPath(...)` tries macOS-specific path variants: shell-unescaped spaces, AM/PM narrow no-break-space filenames, NFD normalization, and curly-quote variants.
- `loadImageInput(...)` also computes `textNote`, `dimensionNote`, and final `bytes`, but `inspect_image` does not include those in tool output.
- Auto-resize can change the MIME type sent to the model. A JPEG or GIF input may be uploaded as PNG, JPEG, or WebP depending on which encoder output is smallest.
- If `resizeImage(...)` throws or cannot decode the image, `loadImageInput(...)` silently keeps the original base64 payload instead of failing.
