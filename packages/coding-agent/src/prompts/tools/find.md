Finds files and directories using fast pattern matching that works with any codebase size.

<instruction>
- `paths` is required and accepts an array of globs, files, or directories
- Pass multiple targets as **separate array elements** (`paths: ["a", "b"]`).
- `gitignore` defaults to `true` and hides files matched by `.gitignore`. Set `gitignore: false` to find `.env*`, `*.log`, freshly-created build outputs, or anything else your repo ignores
- `hidden` defaults to `true`; combine with `gitignore: false` to surface dotfiles that are also gitignored
- `limit` is clamped to 1-200 (default 200). Narrow the pattern instead of raising the limit
- `timeout` is in seconds (default 5, clamped to 0.5–60). On timeout, find returns whatever partial matches it has collected with `truncated: true` and a notice — increase `timeout` or narrow the pattern instead of retrying blindly
- You SHOULD perform multiple searches in parallel when potentially useful
</instruction>

<output>
Matching file and directory paths sorted by modification time (most recent first), grouped by directory to reduce token usage. Each group starts with `# <dir>/` followed by basenames (one per line); directory entries get a trailing `/`. Root-level entries have no header. Truncated at 200 entries or 50KB.
</output>

<examples>
# Find files
`{"paths": ["src/**/*.ts"]}`
# Multiple targets — separate array elements
`{"paths": ["src/**/*.ts", "test/**/*.ts"]}`
# Find gitignored files like .env
`{"paths": [".env*"], "gitignore": false}`
# Find directories matching a name (returns both files and dirs; directories are suffixed with `/`)
`{"paths": ["**/tests"]}`
# Long-running search on a slow volume
`{"paths": ["/Volumes/Storage/**/*.py"], "timeout": 30}`
</examples>

<avoid>
For open-ended searches requiring multiple rounds of globbing and searching, you MUST use Task tool instead.
</avoid>

<critical>
- You MUST use the built-in Find tool for every file-name lookup. NEVER shell out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash — they ignore `.gitignore`, blow past result limits, and waste tokens.
</critical>
