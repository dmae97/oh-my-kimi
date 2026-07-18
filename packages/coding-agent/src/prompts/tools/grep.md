Greps files using regex (Rust regex + PCRE2).

<instruction>
- `path`: scope to known path (e.g. `src`); pass several as delimited list (`src; tests`).
  Line selector on one file (`src/foo.ts:50-100`); selectors never choose search root.
- Cross-line patterns from literal `\n` or `\\n` in `pattern`.
</instruction>

<critical>
- MUST use this over bash when searching!
- Open-ended multi-round search → Task tool + scout subagent, NOT chained `grep` calls.
</critical>
