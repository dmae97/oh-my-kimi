Read files, directories, archives, SQLite databases, images, documents, internal resources, web URLs through single `path` string.

<instruction>
- One tool for filesystem, archives, SQLite, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), internal URIs, web URLs (reader-mode by default).
- SHOULD parallelize independent reads when exploring related files.
- SHOULD reach for `read` — not browser/puppeteer tool — for fetching web content.
</instruction>

## Parameters

- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

Append `:<sel>` to `path`. Bare path falls back to default mode.

- _(none)_ — parseable code → structural summary (signatures kept, bodies elided); other files → read from start (up to {{DEFAULT_LIMIT}} lines).
- `:50` / `:50-` — read from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines starting line 50.
- `:20+1` — exactly one line.
- `:5-16,960-973` — multiple ranges one call (sorted, overlaps merged).
- `:raw` — verbatim text; no anchors, no summary, no line prefixes.
- `:2-4:raw` or `:raw:2-4` — range AND verbatim; compose either order.
- `:conflicts` — one-line-per-block index every unresolved git merge conflict.

# Files

- Read directory path returns depth-limited dirent listing.
{{#if IS_HL_MODE}}
- Read file with explicit selector emits file snapshot tag header and numbered lines: `¶src/foo.ts#0a` then `41:def alpha():`. Copy `¶PATH#TAG` header for anchored edits; ops use bare line numbers. NEVER fabricate tag.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Read file with explicit selector returns lines prefixed with line numbers: `41|def alpha():`.
{{/if}}
{{/if}}
- Parseable code without selector returns **structural summary**: declarations kept, large bodies collapsed to `..` (merged brace pair) or `…` (standalone). Summarized output ends with footer demonstrating multi-range selector you can use to recover elided bodies, e.g.:

  `[NN lines elided; re-read needed ranges, e.g. <path>:5-16,40-80]`

Re-issue **only relevant range(s)** using multi-range selector (e.g. `<path>:5-16,120-200`). NEVER guess what's inside `..` / `…` — markers carry no content. NEVER re-read whole file or use `:raw` when targeted ranges suffice.

# Documents & Notebooks

Extracts text from PDF, Word, PowerPoint, Excel, RTF, EPUB. Notebooks (`.ipynb`) shown as editable `# %% [type] cell:N` text; edits round-trip back to underlying JSON preserving notebook metadata. Add `:raw` to notebook to bypass converter and read JSON directly.

# Images

{{#if INSPECT_IMAGE_ENABLED}}
Reading image path returns metadata (mime, bytes, dimensions, channels, alpha). For actual visual analysis, call `inspect_image` with path and question describing what to inspect.
{{else}}
Reading image path returns decoded image inline (PNG, JPEG, GIF, WEBP) for direct visual analysis.
{{/if}}

# Archives

Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read member, append normal selector to inner path: `archive.zip:dir/file.ts:50-60`.

# SQLite

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — list tables with row counts
- `file.db:table` — schema plus sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs

- Default reader-mode: HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
- `:raw` returns untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate cached fetched output.
- Bare `host:port` URLs collide with selector grammar — add trailing slash before selector: `https://example.com/:80`.

# Internal URIs

`skill://<name>`, `agent://<id>`, `artifact://<id>`, `memory://root`, `rule://<name>`, `local://<name>.md`, `vault://<vault>/<path>`, `mcp://<uri>` resolve transparently; accept same line selectors as filesystem paths. Use `artifact://<id>` to recover full output that previous bash/eval/tool result spilled or truncated.

<critical>
- MUST use `read` for every file, directory, archive, URL inspection. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, `wget` FORBIDDEN — any such bash call is bug, regardless how short or convenient.
- MUST prefer `read` over browser/puppeteer tool for URL content; only reach for browser when `read` cannot deliver reasonable content.
- MUST always include `path`. NEVER call `read` with `{}`.
- For line ranges, append selector to `path` (`path="src/foo.ts:50-200"`, `path="src/foo.ts:50+150"`). NEVER substitute `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- Summary footer says `read <path>:raw …`? Re-issue exact selector it names. NEVER guess what's inside `..` / `…` markers — carry no content.
- MAY combine selectors with URL reads and internal URIs; both paginate cached resolved output.
</critical>
