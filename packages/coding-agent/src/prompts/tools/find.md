Finds files and directories using fast pattern matching; works any codebase size.

<instruction>
- `paths` required; accepts array of globs, files, or directories
- Pass multiple targets as **separate array elements** (`paths: ["a", "b"]`).
- `gitignore` defaults `true`, hides files matched by `.gitignore`. Set `gitignore: false` to find `.env*`, `*.log`, freshly-created build outputs, anything repo ignores
- `hidden` defaults `true`; combine with `gitignore: false` to surface dotfiles also gitignored
- `limit` clamped to 1-200 (default 200). Narrow pattern instead of raising limit
- `timeout` in seconds (default 5, clamped 0.5–60). On timeout, find returns partial matches collected with `truncated: true` and notice — increase `timeout` or narrow pattern instead of retry blindly
- SHOULD perform multiple searches parallel when potentially useful
</instruction>

<output>
Matching file and directory paths sorted by modification time (most recent first), grouped by directory to reduce token usage. Each group starts `# <dir>/` followed basenames (one per line); directory entries get trailing `/`. Root-level entries no header. Truncated at 200 entries or 50KB.
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
For open-ended searches needing multiple glob rounds, MUST use Task tool instead.
</avoid>

<critical>
- MUST use built-in Find tool for every file-name lookup. NEVER shell out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash — ignore `.gitignore`, blow past result limits, waste tokens.
- Catch yourself typing `find -name`, `fd`, or `ls **/*.ext` in Bash command, stop and re-issue lookup through Find tool with glob pattern instead.
</critical>
