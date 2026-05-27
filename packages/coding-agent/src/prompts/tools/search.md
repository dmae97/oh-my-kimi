Searches files using powerful regex matching.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters in place of (?!…)/(?<!…)
- `paths` is required and accepts either one string or an array of files, directories, globs, or internal URLs
- For multiple targets, pass an array with one target per element. Comma-joining inside a single string doesn't work: use `["src", "tests"]`, not `"src,tests"` or `["src,tests"]`
- Cross-line patterns are detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output emits a file-hash header per matched file plus numbered lines: `¶src/login.ts#3c4d`, `*42:if (user.id) {` (match), ` 43:return user;` (context). Copy the header for anchored edits; ops use bare line numbers.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- Reach for the built-in `search` tool for content lookups. Shelling out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, or `sed`-for-search via Bash loses `.gitignore` semantics, bypasses result limits, and wastes tokens — even for a single match or a quick check.
- The `search` tool is faster, returns structured output, and is already wired into the workspace, so Bash-based search ends up being the slower path.
- If you catch yourself typing `grep`, `rg`, or `| grep` in a Bash command, switch to the `search` tool instead.
- For open-ended searches that need multiple rounds, the Task tool with the explore subagent handles that better than chaining `search` calls by hand.
</critical>
