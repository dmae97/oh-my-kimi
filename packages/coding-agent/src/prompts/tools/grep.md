Greps files using regex.

<instruction>
- Supports Rust regex and PCRE2 syntax.
- `path`: SHOULD scope to a known path (e.g. `src`); pass several as a delimited list (`src; tests`). Append a line selector to one file path (e.g. `src/foo.ts:50-100`); selectors never choose the search root.
- Cross-line patterns detected from literal `\n` or `\\n` in `pattern`.
</instruction>

<output>
{{#if IS_HL_MODE}}
- Per matched file: snapshot tag header + numbered lines: `[src/login.ts#1A2B]`, `*42:if (user.id) {` (match), ` 43:return user;` (context). Copy header for anchored edits; ops use bare line numbers.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Output is line-number-prefixed.
{{/if}}
{{/if}}
</output>

<critical>
- MUST use built-in `grep` for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any CLI search via Bash — not even for one match or a quick check.
- Open-ended search needing multiple rounds? MUST use the Task tool with the scout subagent, NOT chained `grep` calls.
</critical>
