Reads the content at the specified path or URL.

<instruction>
The `read` tool is multi-purpose and more capable than it looks — inspects files, directories, archives, SQLite databases, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), **and URLs**.
- You MUST parallelize reads when exploring related files
- For URLs, `read` fetches the page and returns clean extracted text/markdown by default (reader-mode). It handles HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs, etc. You SHOULD reach for `read` — not a browser/puppeteer tool — for fetching and inspecting web content.

## Parameters
- `path` — file path or URL (required). Append `:<sel>` for line ranges or raw mode (for example `src/foo.ts:50-200` or `src/foo.ts:raw`).

## Selectors

|`path` suffix|Behavior|
|---|---|
|_(omitted)_|For parseable code files, return a structural summary. Otherwise read from the start (up to {{DEFAULT_LIMIT}} lines).|
|`:50`|Read from line 50 onward|
|`:50-200`|Read lines 50-200|
|`:50+150`|Read 150 lines starting at line 50|
|`:20+1`|Read exactly one line|
|`:raw`|Read verbatim text without anchors or summarization|
|`:conflicts`|Return a one-line-per-block index of every merge conflict in the file|

# Filesystem
- Reading a directory path returns a list of dirents.
  {{#if IS_HL_MODE}}
- Reading a file with an explicit selector returns lines prefixed with anchors (line+hash): `41th|def alpha():`
  {{else}}
  {{#if IS_LINE_NUMBER_MODE}}
- Reading a file with an explicit selector returns lines prefixed with line numbers: `41|def alpha():`
  {{/if}}
  {{/if}}
- Reading a parseable code file without a selector returns a structural summary with signatures/declarations kept and large bodies collapsed to `…`. Use `:raw` or an explicit range such as `:1-9999` for verbatim content.

# Inspection

Extracts text from PDF, Word, PowerPoint, Excel, RTF, EPUB, and Jupyter notebook files. Notebooks are shown as editable `# %% [type] cell:N` text; edits to that text are applied back to the underlying `.ipynb` JSON while preserving notebook metadata where possible. Can inspect images.

# Directories & Archives

Directories and archive roots return a list of entries. Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read contents, and append a selector to the archive entry such as `archive.zip:dir/file.ts:50-60`.

# SQLite Databases

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — list tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs

Extracts content from web pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom feeds, JSON endpoints, PDFs at URLs, and similar text-based resources. Returns clean reader-mode text/markdown — no browser required. Use a `:raw` suffix for untouched HTML. URL line selectors mirror the file form (`:50`, `:50-100`, `:50+150`, `:raw`). If a URL would otherwise look like `host:port`, add a trailing slash before the selector (e.g. `https://example.com/:80`).
</instruction>

<critical>
- You MUST use `read` for every file, directory, archive, and URL read. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, and `wget` are **FORBIDDEN** for inspection — any such Bash call is a bug, regardless of how short or convenient it looks.
- You MUST prefer `read` over a browser/puppeteer tool for fetching URL content; only use a browser if `read` fails to deliver reasonable content.
- You MUST always include the `path` parameter — never call `read` with an empty argument object `{}`.
- For specific line ranges, append the selector to `path` (e.g. `path="src/foo.ts:50-200"`, `path="src/foo.ts:50+150"`) — do **NOT** reach for `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- You MAY use path suffix selectors with URL reads; the tool paginates cached fetched output.
</critical>
