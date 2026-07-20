# generate_image

> Generate or edit images and write generated image files to temporary paths.

## Source
- Entry: `packages/coding-agent/src/tools/image-gen.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/image-gen.md`
- Session injection: `packages/coding-agent/src/sdk.ts` (`getImageGenTools()`)

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `subject` | `string` | Yes | Main image prompt. For edits, describe the desired result and each input image's role. |
| `action` | `string` | No | What the subject is doing. |
| `scene` | `string` | No | Location or environment. |
| `composition` | `string` | No | Camera angle and framing. |
| `lighting` | `string` | No | Lighting setup. |
| `style` | `string` | No | Artistic style. |
| `text` | `string` | No | Text to render in the image. Keep short and specify legibility when needed. |
| `changes` | `string[]` | No | Edit instructions for input images. |
| `aspect_ratio` | `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9" \| "3:2" \| "2:3"` | No | Requested output aspect ratio. |
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | No | Requested output size where the selected provider supports it. |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | No | Input images by local path or inline base64 data. |

## Outputs
- Success with image data:
  - `content[0].type = "text"`
  - `content[0].text` summarizes provider/model and saved image paths.
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- Provider responses with no image data return `imageCount: 0`, empty `imagePaths` / `images`, and any provider text/feedback available.

## Flow
1. The SDK injects `generate_image` as a custom tool via `getImageGenTools()`.
2. `execute(...)` resolves credentials and provider from the active model registry / session credentials.
3. Input images are resolved from `path` relative to the session cwd or from inline `data` + `mime_type`.
4. The tool validates provider-specific `aspect_ratio` support.
5. Provider dispatch:
   - OpenAI / OpenAI Codex: hosted Responses image-generation path with WebP output.
   - Antigravity: Google Antigravity SSE endpoint.
   - OpenRouter: OpenRouter image-capable chat completion path.
   - xAI: Grok image endpoint.
   - Gemini: Gemini `generateContent` with `responseModalities: ["IMAGE"]`.
6. Inline images from the provider response are saved to temporary files; paths and inline image metadata are returned.

## Modes / Variants
- Text-to-image: provide `subject` and optional style/composition fields, no `input`.
- Image edit: provide one or more `input` images plus `changes` and a subject that identifies each image role.
- Text rendering: use `text`; the prompt instructs callers to request sharp, legible, correctly spelled short text.

## Side Effects
- Filesystem: reads local input images and writes generated output images to temp paths.
- Network: sends prompts and optional images to the selected image provider.
- Session state: reads active model, session id, cwd, credentials, settings, and optional injected `fetch`.
- Background work / cancellation: provider calls use the caller abort signal combined with a 3 minute timeout.

## Limits & Caps
- Local input images are capped at `35 * 1024 * 1024` bytes (`MAX_IMAGE_SIZE`).
- Provider timeout is `3 * 60 * 1000` ms.
- OpenAI output format is WebP.
- Common aspect ratios are `1:1`, `3:4`, `4:3`, `9:16`, and `16:9`; xAI also accepts `3:2` and `2:3`.
- `image_size` schema accepts `1024x1024`, `1536x1024`, and `1024x1536`.

## Errors
- Missing credentials: `No image API credentials found...`
- OpenAI path without an active GPT model: `Missing active GPT model for OpenAI image generation`.
- Antigravity credentials without `projectId`: `Missing projectId in antigravity credentials`.
- Provider HTTP failures surface as provider-specific error messages with status metadata where available.
- Unsupported provider/aspect-ratio combinations fail before the provider request.

## Notes
- The tool is a custom tool, not a built-in `AgentTool` class, so its root docs live here even though the model-facing prompt is in `src/prompts/tools/image-gen.md`.
- Multiple input images should be named in `subject` as `Image 1`, `Image 2`, etc. so the provider receives unambiguous edit instructions.
