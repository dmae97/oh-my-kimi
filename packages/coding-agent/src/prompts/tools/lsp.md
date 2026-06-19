Language Server Protocol (LSP) servers for code intelligence.

<operations>
- `diagnostics`: errors/warnings for a file, glob, or workspace (`file: "*"`)
- `definition`: symbol definition
- `type_definition`: symbol's type definition
- `implementation`: concrete implementations
- `references`: all references
- `hover`: type info / docs
- `symbols`: list file symbols, or search workspace with `file: "*"` + `query`
- `rename`: rename symbol codebase-wide
- `rename_file`: rename/move a file/directory; updates import paths + other references
- `code_actions`: list quick-fixes/refactors/import actions; apply one when `apply: true` + `query` matches title or index
- `status`: active language servers
- `capabilities`: per-server capabilities
- `request`: raw LSP request — `query` = method name (e.g. `rust-analyzer/expandMacro`, `workspace/executeCommand`); `payload` = JSON params
- `reload`: restart one server (via `file`) or all (`file: "*"`)
</operations>

<parameters>
- `file`: path, glob (e.g. `src/**/*.ts`), or `"*"` for workspace scope
- `line`: 1-indexed line for position-based actions
- `symbol`: substring on the target line. Append `#N` for the Nth occurrence — e.g. `foo#2` = second `foo`.
- `query`: symbol search, code-action kind filter/selector (list/apply mode), or LSP method name when `action: request`
- `new_name`: required for `rename` (new identifier) and `rename_file` (destination path)
- `apply`: apply edits for rename/rename_file/code_actions (default true for rename/rename_file; code_actions list mode unless true)
- `payload`: JSON params for `action: request`
- `timeout`: seconds
</parameters>

<caution>
- Missing `symbol` or out-of-bounds `#N` → explicit error.
</caution>

<critical>
- You MUST use `lsp` for symbol-aware operations (rename, references, definition/implementation, code actions) whenever a language server is available — safer and more accurate than text-based alternatives.
- You NEVER perform cross-file renames with `ast_edit`, `sed`, or manual edits when `lsp` `rename` can do it. Text-based renames miss shadowing, re-exports, and cross-file usages.
- You SHOULD use `lsp` `code_actions` for imports, quick-fixes, and refactors the server already applies.
</critical>
