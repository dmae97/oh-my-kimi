Performs structural AST-aware rewrites via native ast-grep.

<instruction>
- Use for codemods and structural rewrites where plain text replace is unsafe
- `path` accepts a comma-separated list in addition to file/dir/glob
- Set `lang` explicitly in mixed-language trees for deterministic rewrites
- Metavariables captured in `pat` (`$A`, `$$$ARGS`) are substituted into that entry's `out` template
- **Patterns match AST structure, not text.** `$NAME` = one node (captured); `$_` = one without binding; `$$$NAME` = zero-or-more (lazy — stops at next matchable element); `$$$` = zero-or-more without binding. Metavariable names are UPPERCASE and **MUST** be the whole AST node — partial text like `prefix$VAR` or `"hello $NAME"` does NOT work
- When the same metavariable appears twice, both occurrences **MUST** match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Rewrite patterns **MUST** parse as a single valid AST node. For method fragments or body snippets that don't parse standalone, wrap in context (e.g. `class $_ { … }`) and set `sel` to target the inner node — match and replacement target the selected node, not the wrapper. If ast-grep reports `Multiple AST nodes are detected`, wrap and use `sel`
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Delete matched code with empty `out`: `{"pat":"console.log($$$)","out":""}`
- Each rewrite is a 1:1 structural substitution — cannot split one capture across multiple nodes or merge multiple captures into one
</instruction>

<output>
- Replacement summary, per-file replacement counts, and change diffs
- Parse issues when files cannot be processed
</output>

<examples>
- Rename a call site across a directory:
  `{"ops":[{"pat":"oldApi($$$ARGS)","out":"newApi($$$ARGS)"}],"lang":"typescript","path":"src/"}`
- Delete matching calls (empty `out` removes the node):
  `{"ops":[{"pat":"console.log($$$ARGS)","out":""}],"lang":"typescript","path":"src/"}`
- Rewrite import source path:
  `{"ops":[{"pat":"import { $$$IMPORTS } from \"old-package\"","out":"import { $$$IMPORTS } from \"new-package\""}],"lang":"typescript","path":"src/"}`
- Modernize to optional chaining (same metavariable enforces identity):
  `{"ops":[{"pat":"$A && $A()","out":"$A?.()"}],"lang":"typescript","path":"src/"}`
- Swap two arguments using captures:
  `{"ops":[{"pat":"assertEqual($A, $B)","out":"assertEqual($B, $A)"}],"lang":"typescript","path":"tests/"}`
- Rename a function declaration while tolerating any return type annotation:
  `{"ops":[{"pat":"async function fetchData($$$ARGS): $_ { $$$BODY }","out":"async function loadData($$$ARGS): $_ { $$$BODY }"}],"sel":"function_declaration","lang":"typescript","path":"src/api.ts"}`
- Rewrite a method body fragment by wrapping in parseable context and selecting the method:
  `{"ops":[{"pat":"class $_ { async execute($INPUT: $_) { $$$BEFORE; const $PARSED = $_.parse($INPUT); $$$AFTER } }","out":"class $_ { async execute($INPUT: $_) { $$$BEFORE; const $PARSED = $SCHEMA.parse($INPUT); $$$AFTER } }"}],"sel":"method_definition","lang":"typescript","path":"src/tools/todo.ts"}`
- Python — convert print calls to logging:
  `{"ops":[{"pat":"print($$$ARGS)","out":"logger.info($$$ARGS)"}],"lang":"python","path":"src/"}`
</examples>

<critical>
- Parse issues mean the rewrite is malformed or mis-scoped — fix the pattern before assuming a clean no-op
- For one-off local text edits, prefer the Edit tool
</critical>
