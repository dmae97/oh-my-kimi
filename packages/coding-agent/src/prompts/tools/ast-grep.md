Performs structural code search using AST matching via native ast-grep.

<instruction>
- Use when syntax shape matters more than raw text (calls, declarations, specific language constructs).
- `paths` REQUIRED; accepts array of files, directories, globs, or internal URLs.
- Language inferred from `paths`; narrow each call to one language when mixed-language trees could cause parse noise
- `pat` single AST pattern. Run separate calls for distinct unrelated patterns
- Patterns match AST structure, not text — whitespace/formatting ignored
- `$NAME` captures one node; `$_` matches one without binding; `$$$NAME` captures zero-or-more (lazy — stops at next matchable element); `$$$` matches zero-or-more without binding. Use `$$$NAME`, NOT `$$NAME` — two-dollar form invalid, produces parse error
- Metavariable names UPPERCASE, MUST be whole AST node — partial-text like `prefix$VAR`, `"hello $NAME"`, or `a $OP b` does NOT work; match whole node instead
- Same metavariable appears twice, both occurrences MUST match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Patterns MUST parse as single valid AST node for inferred target language. For method fragments or body snippets that don't parse standalone, wrap in valid context (e.g. `class $_ { … }`)
- C++ qualified calls used as expression statements need statement semicolon in pattern: use `ns::doThing($ARG);`, `$CALLEE($ARG);`, or wrap statement snippet. Without `;`, tree-sitter-cpp may parse `ns::doThing($ARG)` as declaration-like syntax and return no matches
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Declaration forms structurally distinct — top-level `function foo`, class method `foo()`, `const foo = () => {}` different AST shapes; search right form before concluding absence
- Loosest existence check: `pat: "executeBash"` with narrow `paths`
</instruction>

<output>
- Grouped matches with file path, byte range, line/column ranges, metavariable captures
- Match lines numbered under file snapshot tag header in hashline mode: `¶src/foo.ts#0a`, `*42:content` for matched line, ` 43:content` for context
- Summary counts (`totalMatches`, `filesWithMatches`, `filesSearched`) and parse issues when present
</output>

<examples>
# Search TypeScript files under src
`{"pat":"console.log($$$)","paths":["src/**/*.ts"]}`
# Named imports from a specific package
`{"pat":"import { $$$IMPORTS } from \"react\"","paths":["src/**/*.ts"]}`
# Arrow functions assigned to a const
`{"pat":"const $NAME = ($$$ARGS) => $BODY","paths":["src/utils/**/*.ts"]}`
# Method call on any object, ignoring method name with `$_`
`{"pat":"logger.$_($$$ARGS)","paths":["src/**/*.ts"]}`
# Loosest existence check for a symbol in one file
`{"pat":"processItems","paths":["src/worker.ts"]}`
</examples>

<critical>
- AVOID repo-root scans — narrow `paths` first
- Parse issues are query failure, not evidence of absence: repair pattern or tighten `paths` before concluding "no matches"
- For broad/open-ended exploration across subsystems, use Task tool with explore subagent first
</critical>
