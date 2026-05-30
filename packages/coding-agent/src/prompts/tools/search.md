Searches files using powerful regex matching.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters instead of (?!…)/(?<!…)
- `paths` is required and accepts either one string or an array of files, directories, globs, or internal URLs
- For multiple targets, pass an array with one target per element. Do not comma-join targets inside one string: pass `["src", "tests"]`, not `"src,tests"` or `["src,tests"]`.
- Cross-line patterns are detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output emits a file snapshot tag header per matched file plus numbered lines: `¶src/login.ts#1f`, `*42:if (user.id) {` (match), ` 43:return user;` (context). Copy the header for anchored edits; ops use bare line numbers.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- You MUST use the built-in `search` tool for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any other CLI search via Bash — even for a single match, even "just to check quickly", even piped through other commands.
- Bash `grep`/`rg` loses `.gitignore` semantics, bypasses result limits, and wastes tokens. The `search` tool is faster, structured, and already wired into the workspace — there is no scenario where Bash search is preferable.
- If you catch yourself typing `grep`, `rg`, or `| grep` in a Bash command, stop and re-issue the lookup through the `search` tool instead.
- If the search is open-ended, requiring multiple rounds, you MUST use the Task tool with the explore subagent instead of chaining `search` calls yourself.
</critical>
