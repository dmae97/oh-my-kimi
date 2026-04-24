Reads files using syntax-aware chunks. Also inspects directories, archives, SQLite databases, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), **and URLs**.

<instruction>
The chunk-aware `open` variant returns AST-scoped chunks with stable IDs for structural editing, and otherwise behaves like `open` for non-code content.

- You **MUST** parallelize calls when exploring related files
- For URLs, `open` fetches the page and returns clean extracted text/markdown by default (reader-mode). It handles HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs, etc. You **SHOULD** reach for `open` — not a browser/puppeteer tool — for fetching and inspecting web content.

## Parameters
- `path` — file path or URL; may include `:selector` suffix (required)
- `sel` — optional selector for chunks, line ranges, listing, or raw mode
- `timeout` — seconds, for URLs only

## Selectors

|`sel` value|Behavior|
|---|---|
|*(omitted)*|Read full file as chunks (up to {{DEFAULT_LIMIT}} lines)|
|`class_Foo`|Read a specific chunk|
|`class_Foo.fn_bar#ABCD~`|Read a chunk region (body `~` / head `^`) by ID|
|`?`|List all chunk paths with IDs|
|`L50`|Read from line 50 onward (shorthand for L50 to EOF)|
|`L50-L120`|Read lines 50 through 120|
|`L20-L20`|Read exactly one line|
|`raw`|Raw content without transformations (for URLs: untouched HTML)|

Max {{DEFAULT_MAX_LINES}} lines per call.

# Chunks
Each anchor `@full.chunk.path#CCCC` (with `-` prefixes for nesting depth) in the output identifies a chunk. Use `full.chunk.path#CCCC` as-is to read truncated chunks.
If you need a canonical target list, run `open(path="file", sel="?")`. That listing shows chunk paths with IDs.
Line numbers in the gutter are absolute file line numbers.

{{#if chunkAutoIndent}}
Chunk reads normalize leading indentation so copied content round-trips cleanly into chunk edits.
{{else}}
Chunk reads preserve literal leading tabs/spaces from the file. When editing, keep the same whitespace characters you see here.
{{/if}}

Chunk trees: JS, TS, TSX, Python, Rust, Go. Others use blank-line fallback.
# Inspection
Extracts text from PDF, Word, PowerPoint, Excel, RTF, EPUB, and Jupyter notebook files. Can inspect images.

# Directories & Archives
Directories and archive roots return a list of entries. Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read contents.

# SQLite Databases
When used against a SQLite database (`.sqlite`, `.sqlite3`, `.db`, `.db3`), returns structured database content.
- `file.db` — list tables with row counts
- `file.db:table` — table schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs
Extracts content from web pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom feeds, JSON endpoints, PDFs at URLs, and similar text-based resources. Returns clean reader-mode text/markdown — no browser required. Use `sel="raw"` for untouched HTML; `timeout` to override the default request timeout. You **SHOULD** prefer `open` over a browser/puppeteer tool for fetching URL content; only use a browser when the page requires JS execution, authentication, or interactive actions (clicks, forms, scrolling).
</instruction>

<critical>
- You **MUST** `open` before editing — never invent chunk names or IDs.
    - Chunk names are truncated (e.g., `handleRequest` becomes `fn_handleRequ`). Always copy chunk paths from `open` or `?` output — never construct them from source identifiers.
- You **MUST** use `open` (never bash `cat`/`head`/`tail`/`less`/`more`/`ls`/`tar`/`unzip`/`curl`/`wget`) for all file, directory, archive, and URL reads.
- You **MUST NOT** reach for a browser/puppeteer tool to fetch static web content — `open` handles HTML, PDFs, JSON, feeds, and docs directly. Reserve browser tools for JS-heavy pages or interactive flows.
- You **MUST** always include the `path` parameter; never call with `{}`.
- For specific line ranges, use `sel`: `open(path="file", sel="L50-L150")` — not `cat -n file | sed`.
- You **MAY** use `sel` with URL reads; the tool paginates cached fetched output.
</critical>
