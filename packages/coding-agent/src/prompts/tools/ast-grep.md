Performs structural code search using AST matching via native ast-grep.

<instruction>
- Use when syntax shape matters more than raw text (calls, declarations, specific language constructs)
- `paths` is required and accepts an array of files, directories, globs, or internal URLs
- Language is inferred from `paths`; narrow each call to one language when mixed-language trees could cause parse noise
- `pat` is a single AST pattern. Run separate calls for distinct unrelated patterns
- **Patterns match AST structure, not text** — whitespace/formatting is ignored
- `$NAME` captures one node; `$_` matches one without binding; `$$$NAME` captures zero-or-more (lazy — stops at next matchable element); `$$$` matches zero-or-more without binding. Use `$$$NAME`, NOT `$$NAME` — the two-dollar form is invalid and produces a parse error
- Metavariable names are UPPERCASE and must be the whole AST node — partial-text like `prefix$VAR`, `"hello $NAME"`, or `a $OP b` does NOT work; match the whole node instead
- When the same metavariable appears twice, both occurrences MUST match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Patterns MUST parse as a single valid AST node for the inferred target language. For method fragments or body snippets that don't parse standalone, wrap in valid context (e.g. `class $_ { … }`)
- C++ qualified calls used as expression statements need the statement semicolon in the pattern: use `ns::doThing($ARG);`, `$CALLEE($ARG);`, or wrap a statement snippet. Without `;`, tree-sitter-cpp may parse `ns::doThing($ARG)` as declaration-like syntax and return no matches
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Declaration forms are structurally distinct — top-level `function foo`, class method `foo()`, and `const foo = () => {}` are different AST shapes; search the right form before concluding absence
- Loosest existence check: `pat: "executeBash"` with narrow `paths`
</instruction>

<output>
- Grouped matches with file path, byte range, line/column ranges, metavariable captures
- Match lines are numbered under a file snapshot tag header in hashline mode: `[src/foo.ts#1A2B]`, `*42:content` for the matched line, ` 43:content` for context
- Summary counts (`totalMatches`, `filesWithMatches`, `filesSearched`) and parse issues when present
</output>

<critical>
- AVOID repo-root scans — narrow `paths` first
- Parse issues are query failure, not evidence of absence: repair the pattern or tighten `paths` before concluding "no matches"
- For broad/open-ended exploration across subsystems, you SHOULD use the Task tool with the explore subagent first
</critical>
