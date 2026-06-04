Searches files with regex.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters instead of `(?!…)`/`(?<!…)`
- `paths` accepts one string or array of files, directories, globs, or internal URLs. Optional: when omitted or empty searches workspace root (`.`). Prefer scoping to specific paths when known.
- For multiple targets, pass array with one target per element: `["src", "tests"]`.
- Cross-line patterns detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output emits file snapshot tag header per matched file plus numbered lines: `¶src/login.ts#1f`, `*42:if (user.id) {` (match), ` 43:return user;` (context). Copy header for anchored edits; ops use bare line numbers.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- MUST use built-in `search` tool for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any other CLI search via Bash — even for single match, even "just to check quickly", even piped through other commands.
- Bash `grep`/`rg` loses `.gitignore` semantics, bypasses result limits, wastes tokens. `search` tool faster, structured, already wired into workspace — no scenario where Bash search preferable.
- Catch yourself typing `grep`, `rg`, or `| grep` in Bash — stop, re-issue lookup through `search` tool instead.
- Search open-ended, requiring multiple rounds — MUST use Task tool with explore subagent instead of chaining `search` calls yourself.
</critical>
