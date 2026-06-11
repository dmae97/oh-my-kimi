Prior conversation history has been archived verbatim onto {{frameCount}} snapcompact frame{{#if multipleFrames}}s{{/if}} — the bitmap image{{#if multipleFrames}}s{{/if}} attached below{{#if multipleFrames}}, ordered oldest to newest{{/if}}.

Reading a frame: monospace {{fontCell}} pixel font on a white background, {{cols}} characters per row, {{rows}} text rows per frame; read left to right, top to bottom. Text flows continuously with no word wrap, so words may break across row ends. Whitespace runs (including newlines) were collapsed to single spaces. {{#if sentenceInk}}Ink color cycles through six colors, advancing at sentence boundaries — a color change marks a new sentence.{{else}}Glyphs are plain black ink.{{/if}}{{#if dimmedToolResults}} Tool output is printed in dim gray ink — gray text is archived tool output, not conversation.{{/if}}{{#if lineRepeated}} Every text line is printed twice in a row — first on the white background, then repeated on a pale yellow band. The copies are identical: read each line once and use the duplicate only to double-check hard glyphs.{{/if}} Roles are tagged inline as [User]:, [Assistant]:, [Assistant thinking]:, [Assistant tool calls]:, and [Tool result]:.
{{#if mixedShapes}}

Older frames may use a different font, grid, or ink coloring than described above; the reading order is always the same (left to right, top to bottom, oldest frame first).
{{/if}}
{{#if includedPreviousSummary}}

The earliest frame begins with "[Summary of earlier history]" — a condensed digest of context that predates the archived conversation.
{{/if}}
{{#if truncatedChars}}

{{truncatedChars}} characters of older history were dropped to respect the frame budget. The first frame (session start) is always kept, so the missing span sits between the first frame and the next.
{{/if}}

Total archived: {{totalChars}} characters. Consult the frames whenever you need exact earlier details (user wording, decisions, file paths, tool output). If a region is hard to read, re-derive the fact from the workspace (re-read files, re-run commands) rather than guessing.
