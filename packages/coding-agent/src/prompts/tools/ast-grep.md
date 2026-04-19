Performs structural code search using AST matching via native ast-grep.

<instruction>
- Use when syntax shape matters more than raw text (calls, declarations, specific language constructs)
- `path` accepts a comma-separated list in addition to file/dir/glob
- Set `lang` explicitly in mixed-language trees to avoid parse noise from non-source files
- Multiple patterns in `pat` run in one native pass, merged, then `offset`/`limit` applied
- **Patterns match AST structure, not text** — whitespace/formatting is ignored
- `$NAME` captures one node; `$_` matches one without binding; `$$$NAME` captures zero-or-more (lazy — stops at next matchable element); `$$$` matches zero-or-more without binding
- Metavariable names are UPPERCASE and must be the whole AST node — partial-text like `prefix$VAR`, `"hello $NAME"`, or `a $OP b` does NOT work; match the whole node instead
- When the same metavariable appears twice, both occurrences **MUST** match identical code (`$A == $A` matches `x == x`, not `x == y`)
- Patterns **MUST** parse as a single valid AST node for the target language. For method fragments or body snippets that don't parse standalone, wrap in valid context (e.g. `class $_ { … }`) and set `sel` to target the inner node — results return for the selected node, not the outer wrapper. If ast-grep reports `Multiple AST nodes are detected`, the pattern isn't a single parseable node — wrap and use `sel`
- For TS declarations/methods, tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Declaration forms are structurally distinct — top-level `function foo`, class method `foo()`, and `const foo = () => {}` are different AST shapes; search the right form before concluding absence
- Loosest existence check: `pat: ["executeBash"]` with `sel: "identifier"`
</instruction>

<output>
- Grouped matches with file path, byte range, line/column ranges, metavariable captures
- Summary counts (`totalMatches`, `filesWithMatches`, `filesSearched`) and parse issues when present
</output>

<examples>
- Multi-pattern scoped search:
  `{"pat":["console.log($$$)","console.error($$$)"],"lang":"typescript","path":"src/"}`
- Named imports from a specific package (quoted string inside pattern):
  `{"pat":["import { $$$IMPORTS } from \"react\""],"lang":"typescript","path":"src/"}`
- Arrow functions assigned to a const (distinct AST from function declarations):
  `{"pat":["const $NAME = ($$$ARGS) => $BODY"],"lang":"typescript","path":"src/utils/"}`
- Method call on any object, ignoring method name with `$_`:
  `{"pat":["logger.$_($$$ARGS)"],"lang":"typescript","path":"src/"}`
- Contextual pattern with selector — match the identifier `foo`, not the whole call:
  `{"pat":["foo()"],"sel":"identifier","lang":"typescript","path":"src/utils.ts"}`
- Match a function declaration while tolerating any return type annotation (`sel` targets the inner node):
  `{"pat":["async function processItems($$$ARGS): $_ { $$$BODY }"],"sel":"function_declaration","lang":"typescript","path":"src/worker.ts"}`
- Match a method body fragment by wrapping in parseable context and selecting the method:
  `{"pat":["class $_ { async execute($INPUT: $_) { $$$BEFORE; const $PARSED = $_.parse($INPUT); $$$AFTER } }"],"sel":"method_definition","lang":"typescript","path":"src/tools/todo.ts"}`
- Loosest existence check for a symbol in one file:
  `{"pat":["processItems"],"sel":"identifier","lang":"typescript","path":"src/worker.ts"}`
</examples>

<critical>
- Avoid repo-root AST scans when the target is language-specific — narrow `path` first
- Parse issues are query failure, not evidence of absence: repair the pattern or tighten `path`/`glob`/`lang` before concluding "no matches"
- For broad/open-ended exploration across subsystems, use Task tool with explore subagent first
</critical>
