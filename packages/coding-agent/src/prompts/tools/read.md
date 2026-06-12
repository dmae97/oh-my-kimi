Read files, directories, archives, SQLite databases, images, documents, internal resources, and web URLs through a single `path` string.

<instruction>
- You SHOULD parallelize independent reads when exploring related files.
- You SHOULD reach for `read` — not a browser/puppeteer tool — for web content; browser only when `read` cannot deliver it.
</instruction>

## Parameters

- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `history://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`, `omp://`, `issue://`, `pr://`), or URL. Append `:<sel>` for line ranges or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

Append `:<sel>` to `path`; bare path = default mode.

- _(none)_ — parseable code → structural summary; other files → from start (up to {{DEFAULT_LIMIT}} lines).
- `:50` / `:50-` — from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines starting at 50.
- `:20+1` — anchor line 20 (single-range reads pad ≤1 leading / ≤3 trailing context lines).
- `:5-16,960-973` — multiple ranges in one call (sorted, overlaps merged); exact bounds, no padding.
- `:raw` — verbatim; no anchors, no summary, no line prefixes.
- `:2-4:raw` / `:raw:2-4` — range AND verbatim; compose in either order.
- `:conflicts` — one line per unresolved git merge conflict block.

# Files

- Directory path → depth-limited dirent listing.
{{#if IS_HL_MODE}}
- File with explicit selector → snapshot tag header + numbered lines: `[src/foo.ts#1A2B]` then `41:def alpha():`. Copy the `[PATH#TAG]` header for anchored edits; ops use bare line numbers. NEVER fabricate the tag.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- File with explicit selector → lines prefixed with numbers: `41|def alpha():`.
{{/if}}
{{/if}}
- Parseable code without selector → **structural summary**: declarations kept, bodies collapsed to `..` (merged brace pair) or `…` (standalone). The footer shows the recovery selector: `[NN lines elided; re-read needed ranges, e.g. <path>:5-16,40-80]`. Re-issue ONLY the ranges you need via the multi-range selector. `..`/`…` carry no content — NEVER guess what's inside; NEVER re-read the whole file or `:raw` when ranges suffice.

# Documents & Notebooks

PDF, Word, PowerPoint, Excel, RTF, EPUB → extracted text. Notebooks (`.ipynb`) → editable `# %% [type] cell:N` text; edits round-trip to the underlying JSON preserving metadata. `:raw` bypasses the converter.

# Images

{{#if INSPECT_IMAGE_ENABLED}}
Image path → metadata (mime, bytes, dimensions, channels, alpha). For visual analysis, call `inspect_image` with the path and a question.
{{else}}
Image path → decoded image inline (PNG, JPEG, GIF, WEBP) for direct visual analysis.
{{/if}}

# Archives

`.tar`, `.tar.gz`, `.tgz`, `.zip`. `archive.ext:path/inside/archive` reads a member; inner paths take normal selectors: `archive.zip:dir/file.ts:50-60`.

# SQLite

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — row by primary key
- `file.db:table?limit=50&offset=100` — pagination
- `file.db:table?where=status='active'&order=created:desc` — filter/order
- `file.db?q=SELECT …` — read-only SELECT

# URLs

- Reader-mode by default: HTML, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
- `:raw` → untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate the cached fetch.
- Bare `host:port` collides with the selector grammar — add a trailing slash: `https://example.com/:80`.

# Internal URIs

All `path` URI schemes resolve transparently and take the same line selectors. `artifact://<id>` recovers full output a previous bash/eval/tool result spilled or truncated. `history://<agentId>` is an agent's transcript as concise markdown; bare `history://` lists agents.

<critical>
- You MUST use `read` for every file, directory, archive, and URL inspection. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, `wget` are FORBIDDEN bash calls, however short or convenient.
- Line ranges go in the selector (`path="src/foo.ts:50-200"`) — NEVER `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>
