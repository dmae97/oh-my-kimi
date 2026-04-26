Performs structural AST-aware rewrites via native ast-grep.

<instruction>
- Use for codemods and structural rewrites where plain text replace is unsafe
- `path` is required and accepts a file, directory, glob, comma-separated path list, or internal URL
- Language is inferred from `path`; narrow `path` to one language for deterministic rewrites
- Metavariables captured in `pat` (`$A`, `$$$ARGS`) are substituted into that entry's `out` template
- **Patterns match AST structure, not text.** `$NAME` = one node (captured); `$_` = one without binding; `$$$NAME` = zero-or-more (lazy — stops at next matchable element); `$$$` = zero-or-more without binding. Use `$$$NAME`, **NOT** `$$NAME` — the two-dollar form is invalid. Metavariable names are UPPERCASE and **MUST** be the whole AST node — partial text like `prefix$VAR` or `"hello $NAME"` does NOT work
- When the same metavariable appears twice, both occurrences **MUST** match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Rewrite patterns **MUST** parse as a single valid AST node. For method fragments or body snippets that don't parse standalone, wrap in context (e.g. `class $_ { … }`)
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Delete matched code with empty `out`: `{"pat":"console.log($$$)","out":""}`
- Each rewrite is a 1:1 structural substitution — cannot split one capture across multiple nodes or merge multiple captures into one
</instruction>

<output>
- Replacement summary, per-file replacement counts, and change diffs
- Parse issues when files cannot be processed
</output>

<examples>
# Rename a call site across TypeScript files
`{"ops":[{"pat":"oldApi($$$ARGS)","out":"newApi($$$ARGS)"}],"path":"src/**/*.ts"}`
# Delete matching calls
`{"ops":[{"pat":"console.log($$$ARGS)","out":""}],"path":"src/**/*.ts"}`
# Rewrite import source path
`{"ops":[{"pat":"import { $$$IMPORTS } from \"old-package\"","out":"import { $$$IMPORTS } from \"new-package\""}],"path":"src/**/*.ts"}`
# Modernize to optional chaining (same metavariable enforces identity)
`{"ops":[{"pat":"$A && $A()","out":"$A?.()"}],"path":"src/**/*.ts"}`
# Swap two arguments using captures
`{"ops":[{"pat":"assertEqual($A, $B)","out":"assertEqual($B, $A)"}],"path":"tests/**/*.ts"}`
# Python — convert print calls to logging
`{"ops":[{"pat":"print($$$ARGS)","out":"logger.info($$$ARGS)"}],"path":"src/**/*.py"}`
</examples>

<critical>
- Parse issues mean the rewrite is malformed or mis-scoped — fix the pattern before assuming a clean no-op
- For one-off local text edits, prefer the Edit tool
</critical>
