Finds files and directories via fast pattern matching, any codebase size.

<instruction>
- `paths` (required): array of globs, files, or directories.
- Multiple targets → **separate array elements** (`paths: ["a", "b"]`).
- `gitignore` (default `true`) hides `.gitignore` matches. Set `gitignore: false` to find `.env*`, `*.log`, fresh build outputs, or anything your repo ignores.
- `hidden` (default `true`); combine with `gitignore: false` to surface dotfiles also gitignored.
- `limit` clamped 1-200 (default 200). Narrow the pattern, don't raise it.
- You SHOULD run multiple searches in parallel when useful.
</instruction>

<output>
Matching file/directory paths sorted by mtime (newest first), grouped by directory. Each group: `# <dir>/` then basenames (one per line); directory entries get a trailing `/`. Root-level entries have no header. Truncated at 200 entries or 50KB.
</output>

<avoid>
Open-ended searches needing multiple rounds of globbing/searching: you MUST use the Task tool instead.
</avoid>

<critical>
- You MUST use the built-in Find tool for every file-name lookup. NEVER shell out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash — they ignore `.gitignore`, blow past result limits, and waste tokens.
</critical>
</output>
