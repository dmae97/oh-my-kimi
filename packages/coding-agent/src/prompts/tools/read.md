Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via one `path`.

<instruction>
- SHOULD parallelize independent reads.
- SHOULD use `read` (not a browser tool) for web content; browser only when `read` can't deliver.
</instruction>

## Parameters

- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `history://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`, `omp://`, `issue://`, `pr://`), or URL. Append `:<sel>` for ranges/modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

- _(none)_ — parseable code → structural summary; other files → from start (up to {{DEFAULT_LIMIT}} lines).
- `:50` / `:50-` — from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines from 50.
- `:20+1` — anchor line 20.
- `:5-16,960-973` — multiple ranges in one call.
- `:raw` — verbatim; no anchors/summary/line prefixes.
- `:2-4:raw` / `:raw:2-4` — range AND verbatim; either order.
- `:conflicts` — one line per unresolved git merge conflict block.

# Files

- Directory → depth-limited dirent listing.
{{#if IS_HL_MODE}}
- File + selector → snapshot tag header + numbered lines: `[src/foo.ts#1A2B]` then `41:def alpha():`. Copy `[PATH#TAG]` for anchored edits; ops use bare line numbers. NEVER fabricate the tag.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- File + selector → numbered lines: `41|def alpha():`.
{{/if}}
{{/if}}
- Parseable code, no selector → **structural summary**: declarations kept, body elided with `…`. Footer names the recovery selector; re-issue ONLY the ranges you need.

# Documents & Notebooks

PDF, Word, PowerPoint, Excel, RTF, EPUB → extracted text. Notebooks (`.ipynb`) → editable `# %% [type] cell:N` text. `:raw` bypasses the converter.

# Images

{{#if INSPECT_IMAGE_ENABLED}}
Image → metadata. Visual analysis: call `inspect_image` with the path and a question.
{{else}}
Image → decoded inline (PNG, JPEG, GIF, WEBP) for direct visual analysis.
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

- Reader-mode default: HTML, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
- `:raw` → untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate the fetch.
- Bare `host:port` collides with selector grammar — add a trailing slash: `https://example.com/:80`.

# Internal URIs

All URI schemes take the same line selectors. `artifact://<id>` recovers full output a bash/eval/tool result spilled or truncated. `history://<agentId>` = agent transcript; bare `history://` lists agents.

<critical>
- MUST use `read` for every file/directory/archive/URL inspection. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, `wget` are FORBIDDEN bash calls, however convenient.
- Line ranges go in the selector (`path="src/foo.ts:50-200"`) — NEVER `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>
