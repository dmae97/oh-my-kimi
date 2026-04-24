Reads files using syntax-aware chunks.

<instruction>
- `path` — file path or URL; may include `:selector` suffix
- `sel` — optional selector: `class_Foo`, `class_Foo.fn_bar#ABCD~`, `?`, `L50`, `L50-L120`, or `raw`
- `timeout` — seconds, for URLs only

Each anchor `@full.chunk.path#CCCC` (with `-` prefixes for nesting depth) in the output identifies a chunk. Use `full.chunk.path#CCCC` as-is to read truncated chunks.
If you need a canonical target list, run `open(path="file", sel="?")`. That listing shows chunk paths with IDs.
Line numbers in the gutter are absolute file line numbers.

`L20` (single line, no explicit end) is shorthand for `L20` to end-of-file. Use `L20-L20` for a one-line window.

{{#if chunkAutoIndent}}
Chunk reads normalize leading indentation so copied content round-trips cleanly into chunk edits.
{{else}}
Chunk reads preserve literal leading tabs/spaces from the file. When editing, keep the same whitespace characters you see here.
{{/if}}

Chunk trees: JS, TS, TSX, Python, Rust, Go. Others use blank-line fallback.

# SQLite Databases
When used against a SQLite database (`.sqlite`, `.sqlite3`, `.db`, `.db3`), returns structured database content.
- `file.db` — list tables with row counts
- `file.db:table` — table schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query
</instruction>

<critical>
- **MUST** `open` before editing — never invent chunk names or IDs.
    - Chunk names are truncated (e.g., `handleRequest` becomes `fn_handleRequ`). Always copy chunk paths from `open` or `?` output — never construct them from source identifiers.
</critical>
