Searches files using regex.

<instruction>
- Rust regex (RE2-style) — no lookaround/backreferences; use line anchors or post-filters instead of (?!…)/(?<!…).
- `paths`: SHOULD scope to known paths (e.g. `["src","tests"]`).
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
- Open-ended search needing multiple rounds? MUST use the Task tool with the explore subagent, NOT chained `search` calls.
</critical>
