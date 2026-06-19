Structural AST-aware rewrites via ast-grep.

<instruction>
- Use for codemods / structural rewrites where text replace is unsafe
- Narrow each call to one language
- Metavariables captured in `pat` (`$A`, `$$$ARGS`) substitute into that entry's `out` template
- **Patterns match AST structure, not text.** `$NAME` = one node (captured); `$_` = one without binding; `$$$NAME` = zero-or-more; `$$$` = zero-or-more without binding. Use `$$$NAME`, NOT `$$NAME` — the two-dollar form is invalid. Metavariable names are UPPERCASE and MUST be the whole AST node — partial text like `prefix$VAR` or `"hello $NAME"` does NOT work
- Same metavariable twice → both occurrences MUST match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Rewrite patterns MUST parse as a single valid AST node. Non-standalone snippets → wrap in context, e.g. `class $_ { … }`
- TS declarations/methods — tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Delete matched code with empty `out`: `{"pat":"console.log($$$)","out":""}`
- Each rewrite is a 1:1 substitution — no splitting a capture across nodes or merging captures
</instruction>

<output>
- Change diffs: `[src/foo.ts#1A2B]`, `-12:before`, `+12:after`
</output>

<critical>
- Parse issues mean the rewrite is malformed or mis-scoped — fix the pattern before assuming a clean no-op
- For one-off local text edits, you SHOULD prefer the Edit tool
</critical>
