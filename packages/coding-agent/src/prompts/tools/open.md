Opens and reads the content at the specified path or URL.

<instruction>
The `open` tool is multi-purpose and far more capable than its name might suggest — it inspects files, directories, archives, SQLite databases, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), **and URLs**.

(Previously named `read`. The old name is still accepted as an alias in agent configs and tool lists, but the canonical name is `open`.)
- You **MUST** parallelize calls when exploring related files
- For URLs, `open` fetches the page and returns clean extracted text/markdown by default (reader-mode). It handles HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs, etc. You **SHOULD** reach for `open` — not a browser/puppeteer tool — for fetching and inspecting web content.

## Parameters
- `path` — file path or URL (required)
- `sel` — optional selector for line ranges or raw mode
- `timeout` — seconds, for URLs only

## Selectors

|`sel` value|Behavior|
|---|---|
|*(omitted)*|Read full file (up to {{DEFAULT_LIMIT}} lines)|
|`L50`|Read from line 50 onward|
|`L50-L120`|Read lines 50 through 120|
|`raw`|Raw content without transformations (for URLs: untouched HTML)|

Max {{DEFAULT_MAX_LINES}} lines per call.

# Filesystem
{{#if IS_HASHLINE_MODE}}
- Reading from FS returns lines prefixed with anchors: `41#ZZ:def alpha():`
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Reading from FS returns lines prefixed with line numbers: `41:def alpha():`
{{/if}}
{{/if}}

# Inspection
Extracts text from PDF, Word, PowerPoint, Excel, RTF, EPUB, and Jupyter notebook files. Can inspect images.

# Directories & Archives
Directories and archive roots return a list of entries. Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read contents.

# SQLite Databases
For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — list tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs
Extracts content from web pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom feeds, JSON endpoints, PDFs at URLs, and similar text-based resources. Returns clean reader-mode text/markdown — no browser required. Use `sel="raw"` for untouched HTML; `timeout` to override the default request timeout. You **SHOULD** prefer `open` over a browser/puppeteer tool for fetching URL content; only use a browser when the page requires JS execution, authentication, or interactive actions (clicks, forms, scrolling).
</instruction>

<critical>
- You **MUST** use `open` (never bash `cat`/`head`/`tail`/`less`/`more`/`ls`/`tar`/`unzip`/`curl`/`wget`) for all file, directory, archive, and URL reads.
- You **MUST NOT** reach for a browser/puppeteer tool to fetch static web content — `open` handles HTML, PDFs, JSON, feeds, and docs directly. Reserve browser tools for JS-heavy pages or interactive flows.
- You **MUST** always include the `path` parameter; never call with `{}`.
- For specific line ranges, use `sel`: `open(path="file", sel="L50-L150")` — not `cat -n file | sed`.
- You **MAY** use `sel` with URL reads; the tool paginates cached fetched output.
</critical>
