Performs structural AST-aware rewrites via native ast-grep.

<instruction>
- Use for codemods and structural rewrites where plain text replace is unsafe
- `paths` is required and accepts an array of files, directories, globs, or internal URLs
- Language is inferred from `paths`; narrow each call to one language for deterministic rewrites
- Metavariables captured in `pat` (`$A`, `$$$ARGS`) are substituted into that entry's `out` template
- **Patterns match AST structure, not text.** `$NAME` = one node (captured); `$_` = one without binding; `$$$NAME` = zero-or-more (lazy — stops at next matchable element); `$$$` = zero-or-more without binding. Use `$$$NAME`, NOT `$$NAME` — the two-dollar form is invalid. Metavariable names are UPPERCASE and MUST be the whole AST node — partial text like `prefix$VAR` or `"hello $NAME"` does NOT work
- When the same metavariable appears twice, both occurrences MUST match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Rewrite patterns MUST parse as a single valid AST node. For method fragments or body snippets that don't parse standalone, wrap in context (e.g. `class $_ { … }`)
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Delete matched code with empty `out`: `{"pat":"console.log($$$)","out":""}`
- Each rewrite is a 1:1 structural substitution — cannot split one capture across multiple nodes or merge multiple captures into one
</instruction>

<output>
- Replacement summary, per-file replacement counts, and change diffs as `[src/foo.ts#1A2B]`, `-12:before`, `+12:after` lines in hashline mode
- Parse issues when files cannot be processed
</output>

<critical>
- Parse issues mean the rewrite is malformed or mis-scoped — fix the pattern before assuming a clean no-op
- For one-off local text edits, you SHOULD prefer the Edit tool
</critical>
