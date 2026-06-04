Interacts with Language Server Protocol servers for code intelligence.

<operations>
- `diagnostics`: Get errors/warnings for file, glob, or entire workspace (`file: "*"`)
- `definition`: Go to symbol definition → file path + position + 3-line source context
- `type_definition`: go symbol type definition → file path + position + 3-line source context
- `implementation`: find concrete implementations → file path + position + 3-line source context
- `references`: find references → locations with 3-line source context (first 50), remaining location-only
- `hover`: Get type info and docs → type signature + docs
- `symbols`: List symbols in file, or search workspace with `file: "*"` and `query`
- `rename`: Rename symbol across codebase → preview or apply edits
- `rename_file`: rename or move file/directory; sends `workspace/willRenameFiles` so LSP servers update import paths and other references → preview or apply edits + filesystem rename
- `code_actions`: list available quick-fixes/refactors/import actions; apply one when `apply: true` and `query` matches title or index
- `status`: show active language servers
- `capabilities`: Dump per-server capabilities (standard + experimental + executeCommand list) for discovery — file scopes to one server, omitted/`"*"` lists every active server
- `request`: Send raw LSP request to server — `query` is method name (e.g., `rust-analyzer/expandMacro`, `typescript/goToSourceDefinition`, `workspace/executeCommand`); use `payload` for arbitrary JSON params or let tool auto-build them from `file`/`line`/`symbol`
- `reload`: Restart specific server (via `file`) or all servers with `file: "*"`
</operations>

<parameters>
- `file`: File path, glob pattern (e.g. `src/**/*.ts`), or `"*"` for workspace scope. Globs expanded locally before dispatch. `"*"` routes `diagnostics`/`symbols`/`reload` to workspace-wide form.
- `line`: 1-indexed line number for position-based actions
- `symbol`: Substring on target line used to resolve column automatically. Append `#N` to pick Nth occurrence on that line (1-indexed; default 1) — e.g. `foo#2` selects second `foo`.
- `query`: symbol search query, code-action kind filter/selector (list/apply mode), or LSP method name when `action: request`
- `new_name`: required for `rename` (new symbol identifier) and `rename_file` (destination path)
- `apply`: apply edits for rename/rename_file/code_actions (default true for rename and rename_file; list mode for code_actions unless explicitly true)
- `payload`: JSON-encoded params for `action: request`. Overrides auto-built `{ textDocument, position }` shape when present.
- `timeout`: request timeout seconds, clamped 5-60, default 20
</parameters>

<caution>
- Requires running LSP server for target language
- Need file saved to disk for some operations
- Glob expansion samples up to 20 files per request; use `file: "*"` for broader coverage
- When `symbol` provided for position-based actions, missing symbols or out-of-bounds `#N` occurrence selectors return explicit error instead of silent fallback
</caution>

<critical>
- MUST use `lsp` for symbol-aware operations (rename, find references, go to definition/implementation, code actions) whenever language server available — safer and more accurate than text-based alternatives.
- NEVER perform cross-file renames with `ast_edit`, `sed`, `rsed`, or manual edits when `lsp` `rename` can do it. Text-based renames miss shadowing, re-exports, and usages in other files.
- Prefer `lsp` `code_actions` for imports, quick-fixes, and refactors language server already knows how to apply.
</critical>
