Prior conversation history has been archived verbatim onto {{frameCount}} snapcompact frame{{#if multipleFrames}}s{{/if}} — the bitmap image{{#if multipleFrames}}s{{/if}} attached below{{#if multipleFrames}}, ordered oldest to newest{{/if}}.

Reading a frame: a solid black cell marks a newline and runs of spaces collapse to one; each turn opens with a heading — # User ¶, # Assistant ¶, or # Tool call ¶ — with assistant reasoning in _italics_ and tool output inside <out>…</out>.
{{#if docColumns}}- Two side-by-side text columns, each {{cols}} characters wide and up to {{rows}} rows tall: read the left column top to bottom, then the right.
{{else}}- A single grid {{cols}} characters wide and up to {{rows}} rows tall: read left to right, top to bottom — no word wrap, so words may break across rows.
{{/if}}
{{#if sentenceInk}}- Ink cycles six colors, one per sentence.
{{/if}}{{#if stopwordDimmed}}- Function words are dim gray; content words keep full ink.
{{/if}}{{#if dimmedToolResults}}- Text inside <out> is dim gray; that gray is archived tool output, not conversation.
{{/if}}{{#if lineRepeated}}- Each line is printed twice (white, then a pale-yellow band); the copies are identical.
{{/if}}
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
{{#if textTail}}

The frame budget ran out before the newest part of the archive. That remainder continues below as plain text — it is newer than every frame and ends where the live conversation resumes.

[Archived history, continued as text]
{{textTail}}
{{/if}}
