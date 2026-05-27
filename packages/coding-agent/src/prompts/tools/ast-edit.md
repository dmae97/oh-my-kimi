Performs structural AST-aware rewrites via native ast-grep.

<instruction>
- Use for codemods and structural rewrites where plain text replace isn't safe
- `paths` is required and accepts an array of files, directories, globs, or internal URLs
- Language is inferred from `paths`; narrowing each call to one language keeps rewrites deterministic
- Metavariables captured in `pat` (`$A`, `$$$ARGS`) are substituted into that entry's `out` template
- **Patterns match AST structure, not text.** `$NAME` = one node (captured); `$_` = one without binding; `$$$NAME` = zero-or-more (lazy — stops at next matchable element); `$$$` = zero-or-more without binding. Use `$$$NAME` rather than `$$NAME` — the two-dollar form is invalid. Metavariable names are UPPERCASE and have to be the whole AST node — partial text like `prefix$VAR` or `"hello $NAME"` won't match
- When the same metavariable appears twice, both occurrences need to match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Rewrite patterns need to parse as a single valid AST node. For method fragments or body snippets that don't parse standalone, wrap in context (e.g. `class $_ { … }`)
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Delete matched code with empty `out`: `{"pat":"console.log($$$)","out":""}`
- Each rewrite is a 1:1 structural substitution — you can't split one capture across multiple nodes or merge multiple captures into one
</instruction>

<output>
- Replacement summary, per-file replacement counts, and change diffs as `¶src/foo.ts#1a2b`, `-12:before`, `+12:after` lines in hashline mode
- Parse issues when files cannot be processed
</output>

<examples>
# Rename a call site across TypeScript files
`{"ops":[{"pat":"oldApi($$$ARGS)","out":"newApi($$$ARGS)"}],"paths":["src/**/*.ts"]}`
# Delete matching calls
`{"ops":[{"pat":"console.log($$$ARGS)","out":""}],"paths":["src/**/*.ts"]}`
# Rewrite import source path
`{"ops":[{"pat":"import { $$$IMPORTS } from \"old-package\"","out":"import { $$$IMPORTS } from \"new-package\""}],"paths":["src/**/*.ts"]}`
# Modernize to optional chaining (same metavariable enforces identity)
`{"ops":[{"pat":"$A && $A()","out":"$A?.()"}],"paths":["src/**/*.ts"]}`
# Swap two arguments using captures
`{"ops":[{"pat":"assertEqual($A, $B)","out":"assertEqual($B, $A)"}],"paths":["tests/**/*.ts"]}`
# Python — convert print calls to logging
`{"ops":[{"pat":"print($$$ARGS)","out":"logger.info($$$ARGS)"}],"paths":["src/**/*.py"]}`
</examples>

<critical>
- Parse issues mean the rewrite is malformed or mis-scoped — fix the pattern before treating it as a clean no-op
- For one-off local text edits, reach for the Edit tool
</critical>
