# @oh-my-pi/snapcompact

Bitmap-frame context compression for vision-capable LLMs.

Instead of asking an LLM to summarize discarded conversation history, snapcompact serializes it and renders the text into dense PNG frames of pixel-font glyphs that vision models read back directly. The whole pass is local and deterministic — no LLM call, no API key, no latency beyond rendering. Rasterization and PNG encoding happen in native code (`@oh-my-pi/pi-natives`).

Built for [oh-my-pi](https://github.com/can1357/oh-my-pi)'s compaction pipeline, but the rendering API works on arbitrary text.

## How it works

1. Discarded history is serialized to compact text (`serializeConversation`), with per-tool-result and per-argument character caps.
2. Text is normalized for the bundled bitmap fonts (`normalize`): ANSI sequences stripped, whitespace collapsed, newline runs folded into a single full-block glyph so line structure survives.
3. Pages of text are rasterized into PNG frames (`render` / `renderMany`). Frame width is fixed per shape; height hugs the rows actually printed, so a partially filled frame never bills blank pixel rows.
4. Frames persist in the compaction entry's `preserveData` and are re-attached to the summary message on every context rebuild.

Frame shapes are provider-aware, chosen by SQuAD recall evals (see `research/`) against real provider billing:

| Reader | Default shape | Notes |
| --- | --- | --- |
| Anthropic | `6x12-dim` | X.org 6x12 glyphs, stopwords dimmed gray; high-res Claude lines get 1932px frames |
| Google | `doc-8on16-sent-dim` @2048 | Two newspaper columns, sentence-hue ink; Gemini bills a fixed per-image budget, so larger frames are free chars |
| OpenAI | `8on16-bw` | 8x13 glyphs on a patch-aligned 16px pitch, sent at `detail: "original"` |
| Unknown | Anthropic shape | Per-provider image-count budgets guard against gateways that silently drop frames |

`resolveShape({ api, id })` matches the model id, not just the wire API — a Claude routed through Vertex or OpenRouter keeps its Claude shape, priced for the gateway actually carrying the request.

## Install

```sh
bun add @oh-my-pi/snapcompact
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## Usage

Render arbitrary text into LLM image blocks:

```ts
import { renderMany, frames, resolveShape } from "@oh-my-pi/snapcompact";

const images = renderMany(longText, { model }); // ImageContent[], first page first
const count = frames(longText, { model });      // frame count without rendering
const shape = resolveShape(model);              // eval-optimal Shape for the reader
```

Run a full compaction pass over prepared messages:

```ts
import { compact } from "@oh-my-pi/snapcompact";

const result = await compact(preparation, { model });
// result.summary        — short "resume prior conversation" lead-in, reading guide, and FILES section
// result.preserveData   — bounded archive source + rendered image middle
```

## API surface

- **Compaction**: `compact`, `CompactionPreparation`, `CompactionResult`, `getPreservedArchive`, `images`, `historyBlocks`
- **Rendering**: `render`, `renderMany`, `frames`, `geometry`
- **Shapes**: `SHAPES`, `SHAPE_VARIANTS`, `resolveShape`, `idealShapeVariant`, `isShape`, `isShapeVariantName`
- **Text**: `serializeConversation`, `normalize`, `dimStopwords`, `wrap`
- **Budgets**: `providerImageBudget`, `MAX_FRAMES_DEFAULT`, `FRAME_TOKEN_ESTIMATE`, `HQ_EDGE_FRAMES`
- **File ops**: `createFileOps`, `computeFileLists`, `upsertFileOperations`

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [Compaction architecture](../../docs/compaction.md)
- [CHANGELOG](./CHANGELOG.md)
