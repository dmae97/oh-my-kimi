Finds files using fast pattern matching that works with any codebase size.

<instruction>
- You **SHOULD** perform multiple searches in parallel when potentially useful
</instruction>

<output>
Matching file paths sorted by modification time (most recent first). Truncated at 1000 entries or 50KB (configurable via `limit`).
</output>

<examples>
# Find files
`{"pattern": "src/**/*.ts", "limit": 1000}`
</examples>

<avoid>
For open-ended searches requiring multiple rounds of globbing and searching, you **MUST** use Task tool instead.
</avoid>

<critical>
- You **MUST** use the built-in Find tool for every file-name lookup. Do **NOT** shell out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash — they ignore `.gitignore`, blow past result limits, and waste tokens.
- If you catch yourself typing `find -name`, `fd`, or `ls **/*.ext` in a Bash command, stop and re-issue the lookup through the Find tool with a glob pattern instead.
</critical>
