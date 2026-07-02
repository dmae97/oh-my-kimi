Structural code search via ast-grep.

<instruction>
- Use when syntax shape matters more than text (calls, declarations, language constructs)
- Narrow each call to one language
- `pat` is ONE AST pattern; separate calls for unrelated patterns
- `$NAME` captures one node; `$_` matches one without binding; `$$$NAME` captures zero-or-more; `$$$` matches zero-or-more without binding. Use `$$$NAME`, NOT `$$NAME` — the two-dollar form is invalid
- Metavariable names are UPPERCASE and MUST be the whole AST node — partial text like `prefix$VAR`, `"hello $NAME"`, or `a $OP b` does NOT work
- Same metavariable twice → both occurrences MUST match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Patterns MUST parse as a single valid AST node. Non-standalone snippets → wrap in context, e.g. `class $_ { … }`
- C++ expression-statement calls need trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`
- TS declarations/methods — tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Declaration forms are distinct shapes — `function foo`, method `foo()`, `const foo = () => {}`; search the right form before concluding absence
- Loosest existence check: `pat: "executeBash"` with narrow `path`
</instruction>

<output>
- Matches under a snapshot tag header: `[src/foo.ts#1A2B]`, `*42:` matched, ` 43:` context
</output>

<critical>
- AVOID repo-root scans — narrow `path` first
- Parse issues = query failure, not absence: fix the pattern or tighten `path` before concluding "no matches"
- Broad cross-subsystem exploration: you SHOULD use the Task tool + explore subagent first
</critical>
