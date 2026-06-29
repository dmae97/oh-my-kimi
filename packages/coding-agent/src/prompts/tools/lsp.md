Symbol-aware code intelligence from language servers — the accurate path for navigation, refactors, and diagnostics where text search or edits would miss callsites.

<operations>
Position-based — pass `file` + `line` + `symbol` (substring on that line; append `#N` for the Nth match, e.g. `kind#2`):
- `definition`, `type_definition`, `implementation`, `references`, `hover` — standard LSP lookups
- `rename` — rename the symbol everywhere; **applies by default**, `apply: false` previews; needs `new_name`
- `code_actions` — quick-fixes/refactors/imports at that position; lists by default (`query` filters by kind, e.g. `quickfix`, `source.organizeImports`), **applies one only with `apply: true` + `query`** (then `query` = action title substring or numeric index)

File / workspace:
- `diagnostics` — errors/warnings for a path, a glob (`src/**/*.ts`), or the whole workspace (`file: "*"`)
- `symbols` — `file` lists that file's symbols; `file: "*"` + `query` searches the workspace
- `rename_file` — move `file` → `new_name` on disk AND rewrite imports/references through the server; applies by default

Servers:
- `status`, `capabilities` — what's running / per-server capabilities (one via `file`, all via `*`)
- `reload` — restart one server (`file`) or all (`*`); `reload *` also re-reads project LSP config
- `request` — raw escape hatch: `query` = method (`rust-analyzer/expandMacro`, `workspace/executeCommand`), `payload` = JSON params (else auto-built from `file`/`line`/`symbol`)
</operations>

<caution>
- `line` is 1-indexed. Project-aware `definition`/`references`/`rename` ERROR without `symbol` rather than guess the wrong identifier; a missing match or out-of-range `#N` is an explicit error, never a silent fallback.
</caution>

<critical>
- Symbol-aware work (rename, references, definition/type/impl, code actions) MUST use `lsp` whenever a server is available — it follows shadowing, re-exports, and cross-file usages that text tools miss.
- NEVER do a cross-file rename with `ast_edit`, `sed`, or hand edits when `lsp` `rename`/`rename_file` can — text renames silently drop callsites.
- Reach for `code_actions` on imports, quick-fixes, and server-known refactors before editing by hand.
</critical>
