Reads the content at the specified path or URL.

<instruction>
The `read` tool is multi-purpose — inspects files, directories, archives, SQLite databases, and URLs.
- You **MUST** parallelize reads when exploring related files

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
Extracts content from web pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom feeds, JSON endpoints, and similar text-based resources. Use `sel="raw"` for untouched HTML; `timeout` to override the default request timeout.
</instruction>

<critical>
- You **MUST** use `read` (never bash `cat`/`head`/`tail`/`less`/`more`/`ls`/`tar`/`unzip`) for all file, directory, and archive reads.
- You **MUST** always include the `path` parameter; never call with `{}`.
- For specific line ranges, use `sel`: `read(path="file", sel="L50-L150")` — not `cat -n file | sed`.
- You **MAY** use `sel` with URL reads; the tool paginates cached fetched output.
</critical>
